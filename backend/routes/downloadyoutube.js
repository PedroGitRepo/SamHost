const express = require('express');
const db = require('../config/database');
const authMiddleware = require('../middlewares/authMiddleware');
const YouTubeDownloader = require('../config/YouTubeDownloader');

const router = express.Router();

// POST /api/downloadyoutube/validate - Validar URL do YouTube
router.post('/validate', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.json({ 
        valid: false, 
        message: 'URL é obrigatória' 
      });
    }

    // Validar formato da URL
    const isValid = YouTubeDownloader.validateYouTubeUrl(url);
    
    if (!isValid) {
      return res.json({ 
        valid: false, 
        message: 'URL deve ser do YouTube (youtube.com ou youtu.be)' 
      });
    }

    // Tentar extrair ID do vídeo
    const videoId = YouTubeDownloader.extractVideoId(url);
    
    if (!videoId) {
      return res.json({ 
        valid: false, 
        message: 'Não foi possível extrair ID do vídeo' 
      });
    }

    res.json({ 
      valid: true, 
      message: 'URL válida',
      video_id: videoId
    });

  } catch (error) {
    console.error('Erro ao validar URL:', error);
    res.json({ 
      valid: false, 
      message: 'Erro ao validar URL' 
    });
  }
});

// POST /api/downloadyoutube/info - Obter informações do vídeo
router.post('/info', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL é obrigatória' 
      });
    }

    // Validar URL primeiro
    const isValid = YouTubeDownloader.validateYouTubeUrl(url);
    if (!isValid) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL deve ser do YouTube' 
      });
    }

    // Obter informações do vídeo
    const videoInfo = await YouTubeDownloader.getVideoInfo(url);

    res.json({
      success: true,
      video_info: videoInfo
    });

  } catch (error) {
    console.error('Erro ao obter informações do vídeo:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Erro ao obter informações do vídeo' 
    });
  }
});

// POST /api/downloadyoutube - Iniciar download
router.post('/', authMiddleware, async (req, res) => {
  try {
    console.log('📥 BODY:', req.body);
    console.log('👤 USER:', req.user);

    const { url, id_pasta } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Usuário não autenticado'
      });
    }

    if (!url || !id_pasta) {
      return res.status(400).json({
        success: false,
        error: 'URL e pasta são obrigatórios'
      });
    }

    if (!YouTubeDownloader.validateYouTubeUrl(url)) {
      return res.status(400).json({
        success: false,
        error: 'URL inválida do YouTube'
      });
    }

    const status = YouTubeDownloader.getDownloadStatus(userId);

    if (status?.downloading) {
      return res.status(400).json({
        success: false,
        error: 'Já existe um download ativo'
      });
    }

    const downloadResult = await YouTubeDownloader.downloadVideo(
      userId,
      url,
      id_pasta,
      {} // 👈 ignore quality antiga
    );

    return res.status(200).json({
      success: true,
      message: 'Download iniciado com sucesso',
      download_data: downloadResult
    });

  } catch (error) {
    console.error('❌ DOWNLOAD ENDPOINT ERROR:', error);

    // 🔥 resposta garantida
    return res.status(500).json({
      success: false,
      error: error?.message || 'Erro interno'
    });
  }
});

// GET /api/downloadyoutube/status - Verificar status do download
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const status = YouTubeDownloader.getDownloadStatus(userId);

    res.json({
      success: true,
      ...status
    });

  } catch (error) {
    console.error('Erro ao verificar status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao verificar status do download' 
    });
  }
});

// POST /api/downloadyoutube/cancel - Cancelar download
router.post('/cancel', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await YouTubeDownloader.cancelDownload(userId);

    res.json(result);

  } catch (error) {
    console.error('Erro ao cancelar download:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao cancelar download' 
    });
  }
});

// GET /api/downloadyoutube/recent - Listar downloads recentes
router.get('/recent', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;

    const recentDownloads = await YouTubeDownloader.getRecentDownloads(userId, limit);

    res.json({
      success: true,
      downloads: recentDownloads
    });

  } catch (error) {
    console.error('Erro ao buscar downloads recentes:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao buscar downloads recentes' 
    });
  }
});

// GET /api/downloadyoutube/formats - Listar formatos disponíveis
router.get('/formats', authMiddleware, async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL é obrigatória' 
      });
    }

    // Validar URL
    const isValid = YouTubeDownloader.validateYouTubeUrl(url);
    if (!isValid) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL deve ser do YouTube' 
      });
    }

    // Obter informações do vídeo (que inclui formatos disponíveis)
    const videoInfo = await YouTubeDownloader.getVideoInfo(url);

    // Formatos recomendados baseados no limite do usuário
    const userBitrateLimit = req.user.bitrate || 2500;
    
    const recommendedFormats = [
      {
        quality: 'best[height<=480]',
        label: '480p (SD)',
        description: 'Qualidade básica, menor tamanho',
        estimated_bitrate: 800,
        recommended: userBitrateLimit >= 800
      },
      {
        quality: 'best[height<=720]',
        label: '720p (HD)',
        description: 'Qualidade boa, tamanho médio',
        estimated_bitrate: 1500,
        recommended: userBitrateLimit >= 1500
      },
      {
        quality: 'best[height<=1080]',
        label: '1080p (Full HD)',
        description: 'Alta qualidade, maior tamanho',
        estimated_bitrate: 2500,
        recommended: userBitrateLimit >= 2500
      },
      {
        quality: 'best',
        label: 'Melhor disponível',
        description: 'Máxima qualidade disponível',
        estimated_bitrate: 4000,
        recommended: userBitrateLimit >= 4000
      }
    ];

    res.json({
      success: true,
      video_info: videoInfo,
      formats: recommendedFormats,
      user_bitrate_limit: userBitrateLimit
    });

  } catch (error) {
    console.error('Erro ao obter formatos:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Erro ao obter formatos disponíveis' 
    });
  }
});

// DELETE /api/downloadyoutube/clear-cache - Limpar cache de downloads
router.delete('/clear-cache', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Verificar se há download ativo
    const currentStatus = YouTubeDownloader.getDownloadStatus(userId);
    if (currentStatus.downloading) {
      return res.status(400).json({ 
        success: false, 
        error: 'Não é possível limpar cache durante um download ativo' 
      });
    }

    // Limpar arquivos temporários (implementar se necessário)
    console.log(`Limpando cache de downloads para usuário ${userId}`);

    res.json({
      success: true,
      message: 'Cache limpo com sucesso'
    });

  } catch (error) {
    console.error('Erro ao limpar cache:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao limpar cache' 
    });
  }
});

// GET /api/downloadyoutube/stats - Estatísticas de downloads
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Buscar estatísticas do banco
    const [statsRows] = await db.execute(
      `SELECT 
        COUNT(*) as total_downloads,
        SUM(tamanho_arquivo) as total_size,
        AVG(duracao) as avg_duration,
        MAX(data_upload) as last_download
       FROM videos 
       WHERE codigo_cliente = ? AND origem = 'youtube'`,
      [userId]
    );

    const stats = statsRows[0] || {
      total_downloads: 0,
      total_size: 0,
      avg_duration: 0,
      last_download: null
    };

    // Buscar downloads por mês
    const [monthlyRows] = await db.execute(
      `SELECT 
        DATE_FORMAT(data_upload, '%Y-%m') as month,
        COUNT(*) as downloads,
        SUM(tamanho_arquivo) as size
       FROM videos 
       WHERE codigo_cliente = ? AND origem = 'youtube'
       AND data_upload >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
       GROUP BY DATE_FORMAT(data_upload, '%Y-%m')
       ORDER BY month DESC`,
      [userId]
    );

    res.json({
      success: true,
      stats: {
        total_downloads: stats.total_downloads,
        total_size_mb: Math.ceil((stats.total_size || 0) / (1024 * 1024)),
        avg_duration_minutes: Math.ceil((stats.avg_duration || 0) / 60),
        last_download: stats.last_download,
        monthly_data: monthlyRows
      }
    });

  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao obter estatísticas' 
    });
  }
});

module.exports = router;