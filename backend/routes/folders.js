const express = require('express');
const db = require('../config/database');
const authMiddleware = require('../middlewares/authMiddleware');
const SSHManager = require('../config/SSHManager');
const VideoURLBuilder = require('../config/VideoURLBuilder');

const router = express.Router();

// GET /api/folders - Lista pastas do usuário
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Para revendas, usar o ID efetivo do usuário
    const userId = req.user.effective_user_id || req.user.id;

    console.log(`📁 Carregando pastas para usuário: ${userId}`);
    // Buscar pastas do usuário na nova tabela folders
    const [rows] = await db.execute(
      `SELECT 
        id,
        nome,
        nome_sanitizado,
        caminho_servidor,
        servidor_id,
        espaco_usado,
        data_criacao,
        status,
        (SELECT COUNT(*) FROM videos WHERE pasta = folders.id AND codigo_cliente = ?) as video_count_db
       FROM folders 
       WHERE (user_id = ? OR user_id IN (
         SELECT codigo_cliente FROM streamings WHERE codigo_cliente = ?
       )) AND status = 1
       ORDER BY data_criacao DESC`,
      [userId, userId, userId]
    );

    console.log(`📊 Encontradas ${rows.length} pastas para usuário ${userId}`);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar pastas:', err);
    res.status(500).json({ error: 'Erro ao buscar pastas', details: err.message });
  }
});

// POST /api/folders - Cria nova pasta
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome da pasta é obrigatório' });
    
    // Para revendas, usar o ID efetivo do usuário
    const userId = req.user.effective_user_id || req.user.id;
    const userLogin = req.user.usuario || `user_${userId}`;
    
    // Sanitizar nome da pasta automaticamente
    const sanitizedName = VideoURLBuilder.sanitizeFolderName(nome);
    
    if (sanitizedName !== nome.toLowerCase()) {
      console.log(`📝 Nome da pasta sanitizado: "${nome}" -> "${sanitizedName}"`);
    }

    // Buscar servidor do usuário ou melhor servidor disponível
    const [userServerRows] = await db.execute(
      `SELECT codigo_servidor FROM streamings 
       WHERE (codigo_cliente = ? OR codigo_cliente IN (
         SELECT codigo FROM streamings WHERE codigo_cliente = ?
       )) LIMIT 1`,
      [userId, userId]
    );

    let serverId = userServerRows.length > 0 ? userServerRows[0].codigo_servidor : null;
    
    // Se não tem servidor específico, buscar o melhor servidor disponível
    if (!serverId) {
      const [bestServerRows] = await db.execute(
        `SELECT codigo FROM wowza_servers 
         WHERE status = 'ativo' 
         ORDER BY streamings_ativas ASC, load_cpu ASC 
         LIMIT 1`
      );
      serverId = bestServerRows.length > 0 ? bestServerRows[0].codigo : 1;
      
      console.log(`📡 Usuário ${userId} sem servidor específico, usando melhor disponível: ${serverId}`);
    } else {
      console.log(`📡 Usuário ${userId} usando servidor específico: ${serverId}`);
    }

    // Verificar se pasta já existe
    const [existingRows] = await db.execute(
      'SELECT id FROM folders WHERE user_id = ? AND nome_sanitizado = ?',
      [userId, sanitizedName]
    );

    if (existingRows.length > 0) {
      return res.status(400).json({ 
        error: `Já existe uma pasta com este nome (${sanitizedName})`,
        details: 'Escolha um nome diferente para a pasta'
      });
    }

    // Construir caminho no servidor
    const caminhoServidor = `/home/streaming/${userLogin}/${sanitizedName}`;

    // Criar entrada na nova tabela folders
    const [result] = await db.execute(
      `INSERT INTO folders (
        user_id, nome, nome_sanitizado, caminho_servidor, servidor_id, 
        espaco_usado, data_criacao, status
      ) VALUES (?, ?, ?, ?, ?, 0, NOW(), 1)`,
      [userId, nome, sanitizedName, caminhoServidor, serverId]
    );

    console.log(`💾 Pasta criada no banco com ID: ${result.insertId}`);

    try {
      // Garantir que estrutura do usuário existe primeiro
      // Primeiro, garantir que o diretório base do usuário existe
      console.log(`🏗️ Criando estrutura base para usuário ${userLogin} no servidor ${serverId}`);
      
      const userBaseResult = await SSHManager.createUserDirectory(serverId, userLogin);
      if (!userBaseResult.success) {
        throw new Error(`Falha ao criar diretório base: ${userBaseResult.error || 'Erro desconhecido'}`);
      }
      
      console.log(`✅ Diretório base criado: ${userBaseResult.userDir}`);
      
      // Aguardar criação do diretório base
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Agora criar a pasta específica
      console.log(`📁 Criando pasta específica: ${sanitizedName}`);
      
      const folderResult = await SSHManager.createUserFolder(serverId, userLogin, sanitizedName);
      if (!folderResult.success) {
        throw new Error(`Falha ao criar pasta específica: ${folderResult.error || 'Erro desconhecido'}`);
      }
      
      console.log(`✅ Pasta ${sanitizedName} criada com sucesso: ${folderResult.folderPath}`);
      
      // Verificar se a pasta foi realmente criada
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const verificationResult = await SSHManager.executeCommand(serverId, `test -d "${folderResult.folderPath}" && echo "EXISTS" || echo "NOT_EXISTS"`);
      if (!verificationResult.stdout.includes('EXISTS')) {
        throw new Error(`Pasta não foi criada corretamente: ${folderResult.folderPath}`);
      }
      
      console.log(`✅ Verificação concluída: Pasta ${sanitizedName} existe no servidor`);
      
    } catch (sshError) {
      console.error('Erro ao criar pasta no servidor:', sshError);
      // Remover entrada do banco se falhou no servidor
      await db.execute('DELETE FROM folders WHERE id = ?', [result.insertId]);
      return res.status(500).json({ 
        error: 'Erro ao criar pasta no servidor',
        details: sshError.message,
        debug_info: {
          user_login: userLogin,
          server_id: serverId,
          folder_name: sanitizedName,
          server_path: caminhoServidor
        }
      });
    }

    // Atualizar arquivo SMIL de forma assíncrona (não bloquear resposta)
    setImmediate(async () => {
      try {
        const PlaylistSMILService = require('../services/PlaylistSMILService');
        await PlaylistSMILService.updateUserSMIL(userId, userLogin, serverId);
        console.log(`✅ Arquivo SMIL atualizado para usuário ${userLogin}`);
      } catch (smilError) {
        console.warn('Erro ao atualizar arquivo SMIL:', smilError.message);
      }
    });

    res.status(201).json({
      id: result.insertId,
      nome: nome,
      nome_sanitizado: sanitizedName,
      original_name: nome,
      sanitized: sanitizedName !== nome.toLowerCase(),
      espaco_usado: 0,
      servidor_id: serverId,
      caminho_servidor: caminhoServidor,
      message: 'Pasta criada com sucesso no servidor'
    });
  } catch (err) {
    console.error('Erro ao criar pasta:', err);
    res.status(500).json({ 
      error: 'Erro ao criar pasta', 
      details: err.message,
      debug_info: {
        user_id: userId,
        user_login: userLogin || 'N/A',
        server_id: serverId,
        folder_name: sanitizedName || 'N/A'
      }
    });
  }
});

// PUT /api/folders/:id - Edita pasta
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const folderId = req.params.id;
    const { nome } = req.body;
    const userId = req.user.id;
    const userLogin = req.user.usuario || `user_${userId}`;

    if (!nome) {
      return res.status(400).json({ error: 'Nome da pasta é obrigatório' });
    }
    
    // Sanitizar nome da pasta automaticamente
    const sanitizedName = VideoURLBuilder.sanitizeFolderName(nome);
    
    if (sanitizedName !== nome.toLowerCase()) {
      console.log(`📝 Nome da pasta sanitizado: "${nome}" -> "${sanitizedName}"`);
    }

    // Verificar se a pasta pertence ao usuário
    const [folderRows] = await db.execute(
      'SELECT id, nome_sanitizado, servidor_id FROM folders WHERE id = ? AND user_id = ?',
      [folderId, userId]
    );

    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const folder = folderRows[0];
    const serverId = folder.servidor_id || 1;
    const oldFolderName = folder.nome_sanitizado;

    // Verificar se novo nome já existe
    const [existingRows] = await db.execute(
      'SELECT id FROM folders WHERE user_id = ? AND nome_sanitizado = ? AND id != ?',
      [userId, sanitizedName, folderId]
    );

    if (existingRows.length > 0) {
      return res.status(400).json({ 
        error: `Já existe uma pasta com este nome (${sanitizedName})`,
        details: 'Escolha um nome diferente para a pasta'
      });
    }

    try {
      // Renomear pasta no servidor via SSH
      const oldPath = `/home/streaming/${userLogin}/${oldFolderName}`;
      const newPath = `/home/streaming/${userLogin}/${sanitizedName}`;
      
      // Verificar se pasta antiga existe
      const checkCommand = `test -d "${oldPath}" && echo "EXISTS" || echo "NOT_EXISTS"`;
      const checkResult = await SSHManager.executeCommand(serverId, checkCommand);
      
      if (checkResult.stdout.includes('EXISTS')) {
        // Renomear pasta
        await SSHManager.executeCommand(serverId, `mv "${oldPath}" "${newPath}"`);
        
        // Definir permissões corretas
        await SSHManager.executeCommand(serverId, `chmod -R 755 "${newPath}"`);
        await SSHManager.executeCommand(serverId, `chown -R streaming:streaming "${newPath}"`);
        
        console.log(`✅ Pasta renomeada no servidor: ${oldFolderName} -> ${sanitizedName}`);
      } else {
        // Se pasta não existe no servidor, criar nova
        await SSHManager.createUserFolder(serverId, userLogin, sanitizedName);
        console.log(`✅ Nova pasta criada no servidor: ${sanitizedName}`);
      }
      
    } catch (sshError) {
      console.error('Erro ao renomear pasta no servidor:', sshError);
      return res.status(500).json({ 
        error: 'Erro ao renomear pasta no servidor',
        details: sshError.message 
      });
    }

    // Atualizar nome no banco de dados
    const novoCaminhoServidor = `/home/streaming/${userLogin}/${sanitizedName}`;
    await db.execute(
      'UPDATE folders SET nome = ?, nome_sanitizado = ?, caminho_servidor = ? WHERE id = ?',
      [nome, sanitizedName, novoCaminhoServidor, folderId]
    );

    // Atualizar caminhos dos vídeos no banco se necessário
    await db.execute(
      `UPDATE videos SET 
       url = REPLACE(url, '${userLogin}/${oldFolderName}/', '${userLogin}/${sanitizedName}/'),
       caminho = REPLACE(caminho, '/${oldFolderName}/', '/${sanitizedName}/')
       WHERE pasta = ? AND codigo_cliente = ?`,
      [folderId, userId]
    );

    console.log(`✅ Pasta ${oldFolderName} renomeada para ${sanitizedName} no banco de dados`);

    res.json({ 
      success: true, 
      message: `Pasta renomeada com sucesso${sanitizedName !== nome.toLowerCase() ? ' (nome sanitizado)' : ''}`,
      old_name: oldFolderName,
      new_name: sanitizedName,
      original_name: nome,
      sanitized: sanitizedName !== nome.toLowerCase()
    });
  } catch (err) {
    console.error('Erro ao editar pasta:', err);
    res.status(500).json({ error: 'Erro ao editar pasta', details: err.message });
  }
});

// DELETE /api/folders/:id - Remove pasta
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const folderId = req.params.id;
    const userId = req.user.id;
    const userLogin = req.user.usuario || `user_${userId}`;

    // Verificar se a pasta pertence ao usuário
    const [folderRows] = await db.execute(
      'SELECT id, nome_sanitizado, servidor_id FROM folders WHERE id = ? AND user_id = ?',
      [folderId, userId]
    );

    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const folder = folderRows[0];
    const serverId = folder.servidor_id || 1;
    const folderName = folder.nome_sanitizado;

    // Verificar se há vídeos na pasta
    const [videoCountRows] = await db.execute(
      'SELECT COUNT(*) as count FROM videos WHERE pasta = ? AND codigo_cliente = ?',
      [folderId, userId]
    );

    if (videoCountRows[0].count > 0) {
      return res.status(400).json({ 
        error: 'Não é possível excluir pasta que contém vídeos',
        details: `A pasta contém ${videoCountRows[0].count} vídeo(s). Remova todos os vídeos antes de excluir a pasta.`
      });
    }

    // Verificar se pasta está sendo usada em playlists
    const [playlistRows] = await db.execute(
      'SELECT COUNT(*) as count FROM playlists_videos WHERE path_video LIKE ?',
      [`%/${userLogin}/${folderName}/%`]
    );

    if (playlistRows[0].count > 0) {
      return res.status(400).json({ 
        error: 'Não é possível excluir pasta que está sendo usada em playlists',
        details: `A pasta está sendo usada em ${playlistRows[0].count} item(s) de playlist. Remova-os primeiro.`
      });
    }

    try {
      // Remover pasta do servidor via SSH
      const remoteFolderPath = `/home/streaming/${userLogin}/${folderName}`;
      
      // Verificar se pasta existe no servidor
      const checkCommand = `test -d "${remoteFolderPath}" && echo "EXISTS" || echo "NOT_EXISTS"`;
      const checkResult = await SSHManager.executeCommand(serverId, checkCommand);
      
      if (checkResult.stdout.includes('EXISTS')) {
        // Verificar se pasta está realmente vazia no servidor
        const listCommand = `find "${remoteFolderPath}" -type f | wc -l`;
        const listResult = await SSHManager.executeCommand(serverId, listCommand);
        const fileCount = parseInt(listResult.stdout.trim()) || 0;
        
        if (fileCount > 0) {
          return res.status(400).json({ 
            error: 'Pasta contém arquivos no servidor',
            details: `Encontrados ${fileCount} arquivo(s) no servidor. Remova-os primeiro.`
          });
        }
        
        // Remover pasta vazia
        await SSHManager.executeCommand(serverId, `rmdir "${remoteFolderPath}"`);
        console.log(`✅ Pasta ${folderName} removida do servidor`);
      } else {
        console.log(`⚠️ Pasta ${folderName} não existe no servidor, removendo apenas do banco`);
      }
    } catch (sshError) {
      console.error('Erro ao remover pasta do servidor:', sshError.message);
      return res.status(500).json({ 
        error: 'Erro ao remover pasta do servidor',
        details: sshError.message 
      });
    }

    // Remover pasta
    await db.execute(
      'DELETE FROM folders WHERE id = ? AND user_id = ?',
      [folderId, userId]
    );

    console.log(`✅ Pasta ${folderName} removida do banco de dados`);

    res.json({ success: true, message: 'Pasta removida com sucesso' });
  } catch (err) {
    console.error('Erro ao remover pasta:', err);
    res.status(500).json({ error: 'Erro ao remover pasta', details: err.message });
  }
});

// GET /api/folders/:id/info - Informações detalhadas da pasta
router.get('/:id/info', authMiddleware, async (req, res) => {
  try {
    const folderId = req.params.id;
    const userId = req.user.id;
    const userLogin = req.user.usuario || `user_${userId}`;

    // Buscar dados da pasta
    const [folderRows] = await db.execute(
      `SELECT 
        id,
        nome,
        nome_sanitizado,
        caminho_servidor,
        servidor_id,
        espaco_usado,
        data_criacao,
        status
       FROM folders 
       WHERE id = ? AND user_id = ?`,
      [folderId, userId]
    );

    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const folder = folderRows[0];
    const serverId = folder.servidor_id || 1;
    const folderName = folder.nome_sanitizado;

    // Recalcular espaço usado baseado nos vídeos reais
    const [videoSizeRows] = await db.execute(
      `SELECT COALESCE(SUM(CEIL(tamanho_arquivo / (1024 * 1024))), 0) as real_used_mb
       FROM videos 
       WHERE pasta = ? AND codigo_cliente = ?`,
      [folderId, userId]
    );
    
    const realUsedMB = videoSizeRows[0]?.real_used_mb || 0;
    
    // Verificar se pasta existe no servidor
    let serverInfo = null;
    try {
      const remoteFolderPath = `/home/streaming/${userLogin}/${folderName}`;
      
      // Usar método otimizado que faz tudo em uma chamada
      serverInfo = await SSHManager.getFolderInfo(serverId, remoteFolderPath);
      
      // Atualizar espaço usado se há diferença significativa
      if (serverInfo.exists) {
        const serverSizeMB = serverInfo.size_mb;
        if (Math.abs(serverSizeMB - (folder.espaco_usado || 0)) > 5) {
          await db.execute(
            'UPDATE folders SET espaco_usado = ? WHERE id = ?',
            [Math.max(serverSizeMB, realUsedMB), folderId]
          );
          folder.espaco_usado = Math.max(serverSizeMB, realUsedMB);
        }
      }
    } catch (sshError) {
      console.warn('Erro ao verificar pasta no servidor:', sshError.message);
      serverInfo = {
        exists: false,
        error: sshError.message
      };
    }

    // Contar vídeos no banco
    const [videoCountRows] = await db.execute(
      'SELECT COUNT(*) as count FROM videos WHERE pasta = ? AND codigo_cliente = ?',
      [folderId, userId]
    );

    res.json({
      ...folder,
      video_count_db: videoCountRows[0].count,
      server_info: serverInfo,
      real_used_mb: realUsedMB
    });
  } catch (err) {
    console.error('Erro ao buscar informações da pasta:', err);
    res.status(500).json({ error: 'Erro ao buscar informações da pasta', details: err.message });
  }
});

// POST /api/folders/:id/sync - Sincronizar pasta com servidor
router.post('/:id/sync', authMiddleware, async (req, res) => {
  try {
    const folderId = req.params.id;
    const userId = req.user.id;
    const userLogin = req.user.usuario || `user_${userId}`;

    // Buscar dados da pasta
    const [folderRows] = await db.execute(
      'SELECT id, nome_sanitizado, servidor_id FROM folders WHERE id = ? AND user_id = ?',
      [folderId, userId]
    );

    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const folder = folderRows[0];
    const serverId = folder.servidor_id || 1;
    const folderName = folder.nome_sanitizado;

    try {
      // Garantir que estrutura do usuário existe primeiro
      const userResult = await SSHManager.createUserDirectory(serverId, userLogin);
      if (!userResult.success) {
        console.warn('Aviso ao criar diretório do usuário:', userResult.error);
      }

      // Criar a pasta específica
      const folderResult = await SSHManager.createUserFolder(serverId, userLogin, folderName);
      if (!folderResult.success) {
        console.warn('Aviso ao criar pasta específica:', folderResult.error);
      }

      // Sincronizar arquivos do servidor com banco de dados
      const syncResult = await syncFolderWithServer(folder.id, userLogin, folderName, serverId, userId);

      console.log(`✅ Pasta ${folderName} sincronizada (${syncResult.files_synced} arquivos)`);

      res.json({
        success: true,
        message: 'Pasta sincronizada com sucesso',
        folder_name: folderName,
        server_path: `/home/streaming/${userLogin}/${folderName}`,
        files_synced: syncResult.files_synced,
        files_found: syncResult.files_found,
        user_result: userResult,
        folder_result: folderResult
      });
    } catch (sshError) {
      console.error('Erro na sincronização:', sshError);
      res.status(500).json({
        error: 'Erro ao sincronizar pasta com servidor',
        details: sshError.message
      });
    }
  } catch (err) {
    console.error('Erro na sincronização da pasta:', err);
    res.status(500).json({ error: 'Erro na sincronização da pasta', details: err.message });
  }
});

// Função para sincronizar arquivos do servidor com banco de dados
async function syncFolderWithServer(folderId, userLogin, folderName, serverId, userId) {
  try {
    // Listar arquivos do servidor
    const listCommand = `find /home/streaming/${userLogin}/${folderName} -maxdepth 1 -type f -exec ls -lh {} \\; 2>/dev/null || echo ""`;
    const listResult = await SSHManager.executeCommand(serverId, listCommand);

    let filesFound = 0;
    let filesSynced = 0;

    if (listResult.success && listResult.stdout) {
      const lines = listResult.stdout.trim().split('\n').filter(line => line.length > 0);
      filesFound = lines.length;

      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 9) {
          const fileName = parts.slice(8).join(' ');
          const fileSize = parseInt(parts[4]) || 0;
          const modifiedDate = `${parts[5]} ${parts[6]} ${parts[7]}`;

          // Verificar se arquivo já existe no banco
          const [existingFiles] = await db.execute(
            'SELECT id FROM videos WHERE pasta = ? AND nome = ? AND codigo_cliente = ?',
            [folderId, fileName, userId]
          );

          if (existingFiles.length === 0) {
            // Inserir novo arquivo
            await db.execute(
              `INSERT INTO videos (
                pasta, nome, tamanho, data_criacao, codigo_cliente,
                status, data_atualizacao
              ) VALUES (?, ?, ?, NOW(), ?, 1, NOW())`,
              [folderId, fileName, fileSize, userId]
            );

            console.log(`  📹 Arquivo sincronizado: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
            filesSynced++;
          }
        }
      }

      console.log(`  ✅ Sincronização concluída: ${filesSynced}/${filesFound} novos arquivos`);
    }

    return { files_found: filesFound, files_synced: filesSynced };
  } catch (error) {
    console.error('Erro ao sincronizar arquivos:', error);
    return { files_found: 0, files_synced: 0, error: error.message };
  }
}

module.exports = router;