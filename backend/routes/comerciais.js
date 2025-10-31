const express = require('express');
const db = require('../config/database');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

// Função auxiliar para inserir comerciais na playlist
async function inserirComerciaisNaPlaylist(userId, playlistId, folderId, quantidadeComerciais, intervaloVideos) {
  try {
    console.log(`📺 Inserindo comerciais na playlist ${playlistId}`);

    // Buscar vídeos da pasta de comerciais
    const [comerciaisVideos] = await db.execute(
      `SELECT id, nome FROM videos
       WHERE pasta = ? AND codigo_cliente = ?
       ORDER BY nome ASC`,
      [folderId, userId]
    );

    if (comerciaisVideos.length === 0) {
      console.warn('⚠️ Nenhum vídeo encontrado na pasta de comerciais');
      return;
    }

    // Buscar vídeos atuais da playlist (usando tabela playlist_videos)
    const [playlistVideosAtual] = await db.execute(
      `SELECT pv.id, pv.video_id, pv.ordem, v.nome
       FROM playlist_videos pv
       INNER JOIN videos v ON pv.video_id = v.id
       WHERE pv.playlist_id = ?
       ORDER BY pv.ordem ASC`,
      [playlistId]
    );

    console.log(`📋 Playlist tem ${playlistVideosAtual.length} vídeos, inserindo ${quantidadeComerciais} comerciais a cada ${intervaloVideos} vídeos`);

    // Criar nova ordem com comerciais intercalados
    const novaOrdem = [];
    let indiceComercia = 0;

    for (let i = 0; i < playlistVideosAtual.length; i++) {
      // Adicionar vídeo normal
      novaOrdem.push({
        video_id: playlistVideosAtual[i].video_id,
        tipo: 'video'
      });

      // Verificar se deve inserir comerciais
      const posicao = i + 1;
      if (posicao % intervaloVideos === 0 && posicao < playlistVideosAtual.length) {
        // Inserir quantidade especificada de comerciais
        for (let j = 0; j < quantidadeComerciais; j++) {
          const comercial = comerciaisVideos[indiceComercia % comerciaisVideos.length];
          novaOrdem.push({
            video_id: comercial.id,
            tipo: 'comercial'
          });
          indiceComercia++;
        }
      }
    }

    // Limpar playlist atual
    await db.execute(
      'DELETE FROM playlist_videos WHERE playlist_id = ?',
      [playlistId]
    );

    // Inserir nova ordem com comerciais
    for (let i = 0; i < novaOrdem.length; i++) {
      await db.execute(
        'INSERT INTO playlist_videos (playlist_id, video_id, ordem) VALUES (?, ?, ?)',
        [playlistId, novaOrdem[i].video_id, i]
      );
    }

    // Atualizar estatísticas da playlist
    const [statsRows] = await db.execute(
      `SELECT COUNT(DISTINCT pv.id) as total_videos, SUM(v.duracao) as duracao_total
       FROM playlist_videos pv
       INNER JOIN videos v ON pv.video_id = v.id
       WHERE pv.playlist_id = ?`,
      [playlistId]
    );

    const stats = statsRows[0];
    await db.execute(
      'UPDATE playlists SET total_videos = ?, duracao_total = ? WHERE id = ?',
      [stats.total_videos || 0, stats.duracao_total || 0, playlistId]
    );

    console.log(`✅ Comerciais inseridos com sucesso! Total de vídeos na playlist: ${novaOrdem.length}`);

  } catch (error) {
    console.error('Erro ao inserir comerciais na playlist:', error);
    throw error;
  }
}

// GET /api/comerciais - Lista configurações de comerciais
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await db.execute(
      `SELECT 
        codigo as id,
        codigo_playlist as id_playlist,
        codigo_pasta_comerciais as id_folder_comerciais,
        quantidade_comerciais,
        intervalo_videos,
        ativo
       FROM comerciais_config 
       WHERE (codigo_stm = ? OR codigo_stm IN (
         SELECT codigo_cliente FROM streamings WHERE codigo = ?
       ))
       ORDER BY codigo`,
      [userId, userId]
    );

    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar comerciais:', err);
    res.status(500).json({ error: 'Erro ao buscar comerciais', details: err.message });
  }
});

// POST /api/comerciais - Cria configuração de comerciais
router.post('/', authMiddleware, async (req, res) => {
  try {
    const {
      id_playlist,
      id_folder_comerciais,
      quantidade_comerciais,
      intervalo_videos,
      ativo
    } = req.body;

    const userId = req.user.id;

    if (!id_playlist || !id_folder_comerciais) {
      return res.status(400).json({ error: 'Playlist e pasta de comerciais são obrigatórios' });
    }

    const [result] = await db.execute(
      `INSERT INTO comerciais_config (
        codigo_stm, codigo_playlist, codigo_pasta_comerciais,
        quantidade_comerciais, intervalo_videos, ativo
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, id_playlist, id_folder_comerciais, quantidade_comerciais || 1, intervalo_videos || 3, ativo ? 1 : 0]
    );

    // NOVA FUNCIONALIDADE: Adicionar comerciais à playlist automaticamente
    if (ativo) {
      try {
        await inserirComerciaisNaPlaylist(
          userId,
          id_playlist,
          id_folder_comerciais,
          quantidade_comerciais || 1,
          intervalo_videos || 3
        );
      } catch (insertError) {
        console.error('Erro ao inserir comerciais na playlist:', insertError);
        // Não falhar a criação da config se inserção falhar
      }
    }

    res.status(201).json({
      id: result.insertId,
      message: 'Configuração de comerciais criada com sucesso'
    });
  } catch (err) {
    console.error('Erro ao criar comerciais:', err);
    res.status(500).json({ error: 'Erro ao criar comerciais', details: err.message });
  }
});

// PUT /api/comerciais/:id - Atualiza configuração de comerciais
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const comercialId = req.params.id;
    const userId = req.user.id;
    const { ativo, quantidade_comerciais, intervalo_videos } = req.body;

    // Verificar se configuração pertence ao usuário
    const [comercialRows] = await db.execute(
      'SELECT codigo, codigo_playlist, codigo_pasta_comerciais, quantidade_comerciais, intervalo_videos FROM comerciais_config WHERE codigo = ? AND codigo_stm = ?',
      [comercialId, userId]
    );

    if (comercialRows.length === 0) {
      return res.status(404).json({ error: 'Configuração não encontrada' });
    }

    const comercialConfig = comercialRows[0];

    // Atualizar configuração
    const updates = [];
    const values = [];

    if (typeof ativo !== 'undefined') {
      updates.push('ativo = ?');
      values.push(ativo ? 1 : 0);
    }

    if (quantidade_comerciais) {
      updates.push('quantidade_comerciais = ?');
      values.push(quantidade_comerciais);
    }

    if (intervalo_videos) {
      updates.push('intervalo_videos = ?');
      values.push(intervalo_videos);
    }

    if (updates.length > 0) {
      values.push(comercialId);
      await db.execute(
        `UPDATE comerciais_config SET ${updates.join(', ')} WHERE codigo = ?`,
        values
      );
    }

    // NOVA FUNCIONALIDADE: Atualizar playlist quando comerciais são ativados
    if (typeof ativo !== 'undefined' && ativo) {
      try {
        await inserirComerciaisNaPlaylist(
          userId,
          comercialConfig.codigo_playlist,
          comercialConfig.codigo_pasta_comerciais,
          quantidade_comerciais || comercialConfig.quantidade_comerciais,
          intervalo_videos || comercialConfig.intervalo_videos
        );
      } catch (insertError) {
        console.error('Erro ao inserir comerciais na playlist:', insertError);
        // Não falhar a atualização se inserção falhar
      }
    }

    res.json({ success: true, message: 'Configuração atualizada com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar comerciais:', err);
    res.status(500).json({ error: 'Erro ao atualizar comerciais', details: err.message });
  }
});

// POST /api/comerciais/:id/aplicar - Aplica comerciais manualmente na playlist
router.post('/:id/aplicar', authMiddleware, async (req, res) => {
  try {
    const comercialId = req.params.id;
    const userId = req.user.id;

    // Buscar configuração do comercial
    const [comercialRows] = await db.execute(
      'SELECT codigo_playlist, codigo_pasta_comerciais, quantidade_comerciais, intervalo_videos FROM comerciais_config WHERE codigo = ? AND codigo_stm = ?',
      [comercialId, userId]
    );

    if (comercialRows.length === 0) {
      return res.status(404).json({ error: 'Configuração não encontrada' });
    }

    const config = comercialRows[0];

    // Aplicar comerciais na playlist
    await inserirComerciaisNaPlaylist(
      userId,
      config.codigo_playlist,
      config.codigo_pasta_comerciais,
      config.quantidade_comerciais,
      config.intervalo_videos
    );

    res.json({
      success: true,
      message: 'Comerciais aplicados à playlist com sucesso!'
    });
  } catch (err) {
    console.error('Erro ao aplicar comerciais:', err);
    res.status(500).json({ error: 'Erro ao aplicar comerciais', details: err.message });
  }
});

// DELETE /api/comerciais/:id - Remove configuração de comerciais
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const comercialId = req.params.id;
    const userId = req.user.id;

    // Verificar se configuração pertence ao usuário
    const [comercialRows] = await db.execute(
      'SELECT codigo FROM comerciais_config WHERE codigo = ? AND codigo_stm = ?',
      [comercialId, userId]
    );

    if (comercialRows.length === 0) {
      return res.status(404).json({ error: 'Configuração não encontrada' });
    }

    // Remover configuração
    await db.execute(
      'DELETE FROM comerciais_config WHERE codigo = ?',
      [comercialId]
    );

    res.json({ success: true, message: 'Configuração removida com sucesso' });
  } catch (err) {
    console.error('Erro ao remover comerciais:', err);
    res.status(500).json({ error: 'Erro ao remover comerciais', details: err.message });
  }
});

module.exports = router;