const jwt = require('jsonwebtoken');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'sua_chave_secreta_super_segura_aqui';

const authMiddleware = async (req, res, next) => {
  // Garante que SEMPRE haverá JSON na resposta
  res.setHeader('Content-Type', 'application/json');

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Token de acesso requerido',
        details: 'Faça login novamente para acessar este recurso'
      });
    }

    const token = authHeader.substring(7);

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'Token expirado',
          expired: true
        });
      }

      return res.status(401).json({
        error: 'Token inválido'
      });
    }

    let rows = [];

    try {
      // Buscar baseado no tipo de usuário
      if (decoded.tipo === 'revenda') {
        [rows] = await db.execute(
          `SELECT 
            codigo, 
            nome, 
            email, 
            usuario, 
            streamings, 
            espectadores, 
            bitrate, 
            espaco, 
            status, 
            'revenda' as tipo, 
            codigo as codigo_cliente 
           FROM revendas 
           WHERE codigo = ? AND status = 1`,
          [decoded.userId]
        );
      } else {
        [rows] = await db.execute(
          `SELECT 
            s.codigo, 
            s.identificacao as nome, 
            s.email, 
            s.usuario,
            1 as streamings, 
            s.espectadores, 
            s.bitrate, 
            s.espaco, 
            s.status,
            'streaming' as tipo,
            s.codigo_cliente,
            s.codigo_servidor
           FROM streamings s 
           WHERE s.codigo_cliente = ? AND s.status = 1 
           LIMIT 1`,
          [decoded.userId]
        );
      }
    } catch (dbError) {
      console.error('❌ Erro no banco durante autenticação:', dbError);
      return res.status(500).json({
        error: 'Erro interno de autenticação'
      });
    }

    if (!rows || rows.length === 0) {
      return res.status(401).json({
        error: 'Usuário não encontrado ou inativo'
      });
    }

    const user = rows[0];

    req.user = {
      id: user.codigo_cliente || user.codigo,
      nome: user.nome,
      email: user.email,
      usuario: user.usuario || (user.email ? user.email.split('@')[0] : `user_${user.codigo}`),
      tipo: user.tipo || 'streaming',
      streamings: user.streamings,
      espectadores: user.espectadores,
      bitrate: user.bitrate,
      espaco: user.espaco,
      codigo_cliente: user.codigo_cliente || null,
      codigo_servidor: user.codigo_servidor || null,
      effective_user_id:
        user.tipo === 'revenda'
          ? user.codigo
          : (user.codigo_cliente || user.codigo)
    };

    next();

  } catch (error) {
    console.error('❌ Erro fatal no middleware de autenticação:', error);

    if (res.headersSent) return;

    return res.status(500).json({
      error: 'Erro interno do servidor'
    });
  }
};

module.exports = authMiddleware;
