const express = require('express');
const db = require('../config/database');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

// GET /api/agendamentos - Lista agendamentos do usuário
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Para revendas, usar o ID efetivo do usuário
    const userId = req.user.effective_user_id || req.user.id;
    const { mesAno } = req.query; // formato: YYYY-MM

    let query = `
      SELECT 
        pa.codigo as id,
        pa.data,
        pa.codigo_playlist as id_playlist,
        p.nome as nome_playlist_principal,
        pa.shuffle,
        pa.frequencia,
        pa.finalizacao,
        pa.codigo_playlist_finalizacao,
        pf.nome as nome_playlist_finalizacao,
        CONCAT(pa.data, ' ', LPAD(pa.hora, 2, '0'), ':', LPAD(pa.minuto, 2, '0'), ':00') as inicio,
        pa.dias as dias_semana
      FROM playlists_agendamentos pa
      LEFT JOIN playlists p ON pa.codigo_playlist = p.id
      LEFT JOIN playlists pf ON pa.codigo_playlist_finalizacao = pf.id
      WHERE (pa.codigo_stm = ? OR pa.codigo_stm IN (
        SELECT codigo_cliente FROM streamings WHERE codigo_cliente = ?
      ))
    `;

    const params = [userId, userId];

    if (mesAno) {
      query += ' AND DATE_FORMAT(pa.data, "%Y-%m") = ?';
      params.push(mesAno);
    }

    query += ' ORDER BY pa.data, pa.hora, pa.minuto';

    const [rows] = await db.execute(query, params);

    // Processar dados para o formato esperado
    const agendamentos = rows.map(row => ({
      ...row,
      shuffle: row.shuffle === 'sim' ? 'sim' : 'nao',
      finalizacao: row.finalizacao === 'repetir' ? 'nao' : 'sim',
      dias_semana: row.dias_semana ? row.dias_semana.split(',').map(d => parseInt(d)) : []
    }));

    res.json(agendamentos);
  } catch (err) {
    console.error('Erro ao buscar agendamentos:', err);
    res.status(500).json({ error: 'Erro ao buscar agendamentos', details: err.message });
  }
});

// POST /api/agendamentos - Cria novo agendamento
router.post('/', authMiddleware, async (req, res) => {
  try {
    const {
      data,
      id_playlist,
      shuffle,
      frequencia,
      finalizacao,
      id_playlist_finalizacao,
      inicio,
      dias_semana
    } = req.body;

    // Para revendas, usar o ID efetivo do usuário
    const userId = req.user.effective_user_id || req.user.id;

    if (!data || !id_playlist || !inicio) {
      return res.status(400).json({ error: 'Data, playlist e horário de início são obrigatórios' });
    }

    // Verificar duplicidade de agendamentos
    const inicioDate = new Date(inicio);
    const hora = inicioDate.getHours().toString().padStart(2, '0');
    const minuto = inicioDate.getMinutes().toString().padStart(2, '0');

    // Verificar se já existe agendamento de playlist no mesmo horário
    const [existingPlaylist] = await db.execute(
      `SELECT pa.codigo, p.nome FROM playlists_agendamentos pa
       JOIN playlists p ON pa.codigo_playlist = p.id
       WHERE pa.codigo_stm = ? AND pa.data = ? AND pa.hora = ? AND pa.minuto = ?`,
      [userId, data, hora, minuto]
    );

    // Verificar se já existe agendamento de relay no mesmo horário
    const [existingRelay] = await db.execute(
      `SELECT codigo, url_origem FROM relay_config
       WHERE codigo_stm = ? AND DATE(data_inicio) = ? AND HOUR(data_inicio) = ? AND MINUTE(data_inicio) = ?`,
      [userId, data, hora, minuto]
    );

    let warnings = [];
    if (existingPlaylist.length > 0) {
      warnings.push(`Já existe um agendamento de playlist "${existingPlaylist[0].nome}" neste horário.`);
    }
    if (existingRelay.length > 0) {
      warnings.push(`Já existe um agendamento de relay neste horário.`);
    }

    // Mapear frequência
    const frequenciaMap = {
      'diariamente': 1,
      'dias_da_semana': 2,
      'uma_vez': 3
    };

    const frequenciaValue = frequenciaMap[frequencia] || 3;

    // Processar dias da semana
    const diasString = dias_semana && Array.isArray(dias_semana) ? dias_semana.join(',') : '';

    const [result] = await db.execute(
      `INSERT INTO playlists_agendamentos (
        codigo_stm, codigo_playlist, frequencia, data, hora, minuto,
        dias, shuffle, finalizacao, codigo_playlist_finalizacao, servidor_relay
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
      [
        userId,
        id_playlist,
        frequenciaValue,
        data,
        hora,
        minuto,
        diasString,
        shuffle ? 'sim' : 'nao',
        finalizacao ? 'playlist' : 'repetir',
        id_playlist_finalizacao || 0
      ]
    );

    // Atualizar arquivo SMIL do usuário após criar agendamento
    try {
      const effectiveUserId = req.user.effective_user_id || req.user.id;
      const userLogin = req.user.usuario || `user_${effectiveUserId}`;
      const [serverRows] = await db.execute(
        `SELECT servidor_id FROM folders 
         WHERE (user_id = ? OR user_id IN (
           SELECT codigo FROM streamings WHERE codigo_cliente = ?
         )) LIMIT 1`,
        [effectiveUserId, effectiveUserId]
      );
      const serverId = serverRows.length > 0 ? serverRows[0].servidor_id : 1;
      
      const PlaylistSMILService = require('../services/PlaylistSMILService');
      await PlaylistSMILService.updateUserSMIL(effectiveUserId, userLogin, serverId);
      console.log(`✅ Arquivo SMIL atualizado após criar agendamento para usuário ${userLogin} em /home/streaming/${userLogin}/playlists_agendamentos.smil`);
    } catch (smilError) {
      console.warn('Erro ao atualizar arquivo SMIL:', smilError.message);
    }

    res.status(201).json({
      id: result.insertId,
      message: 'Agendamento criado com sucesso',
      warnings: warnings.length > 0 ? warnings : undefined
    });
  } catch (err) {
    console.error('Erro ao criar agendamento:', err);
    res.status(500).json({ error: 'Erro ao criar agendamento', details: err.message });
  }
});

// DELETE /api/agendamentos/:id - Remove agendamento
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const agendamentoId = req.params.id;
    // Para revendas, usar o ID efetivo do usuário
    const userId = req.user.effective_user_id || req.user.id;

    // Verificar se agendamento pertence ao usuário
    const [agendamentoRows] = await db.execute(
      `SELECT codigo FROM playlists_agendamentos 
       WHERE codigo = ? AND (codigo_stm = ? OR codigo_stm IN (
         SELECT codigo_cliente FROM streamings WHERE codigo_cliente = ?
       ))`,
      [agendamentoId, userId, userId]
    );

    if (agendamentoRows.length === 0) {
      return res.status(404).json({ error: 'Agendamento não encontrado' });
    }

    // Remover agendamento
    await db.execute(
      'DELETE FROM playlists_agendamentos WHERE codigo = ?',
      [agendamentoId]
    );

    // Atualizar arquivo SMIL do usuário após remover agendamento
    try {
      const effectiveUserId = req.user.effective_user_id || req.user.id;
      const userLogin = req.user.usuario || `user_${req.user.id}`;
      const [serverRows] = await db.execute(
        `SELECT servidor_id FROM folders 
         WHERE (user_id = ? OR user_id IN (
           SELECT codigo FROM streamings WHERE codigo_cliente = ?
         )) LIMIT 1`,
        [effectiveUserId, effectiveUserId]
      );
      const serverId = serverRows.length > 0 ? serverRows[0].servidor_id : 1;
      
      const PlaylistSMILService = require('../services/PlaylistSMILService');
      await PlaylistSMILService.updateUserSMIL(effectiveUserId, userLogin, serverId);
    } catch (smilError) {
      console.warn('Erro ao atualizar arquivo SMIL:', smilError.message);
    }

    res.json({ success: true, message: 'Agendamento removido com sucesso' });
  } catch (err) {
    console.error('Erro ao remover agendamento:', err);
    res.status(500).json({ error: 'Erro ao remover agendamento', details: err.message });
  }
});

module.exports = router;