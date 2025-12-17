-- Migração: Criação da tabela recording_sessions
-- Data: 2025-10-17
-- Descrição: Tabela para gerenciar sessões de gravação de transmissões ao vivo

-- Tabela principal de sessões de gravação
CREATE TABLE IF NOT EXISTS recording_sessions (
    codigo INT AUTO_INCREMENT PRIMARY KEY COMMENT 'ID único da sessão de gravação',
    codigo_stm INT NOT NULL COMMENT 'ID do streaming/usuário',
    arquivo_destino VARCHAR(255) NOT NULL COMMENT 'Nome do arquivo de destino',
    caminho_completo VARCHAR(500) NULL COMMENT 'Caminho completo do arquivo no servidor',
    status ENUM('recording', 'stopped', 'error') DEFAULT 'recording' COMMENT 'Status da gravação',
    data_inicio DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT 'Data e hora de início',
    data_fim DATETIME NULL COMMENT 'Data e hora de término',
    tamanho_arquivo BIGINT DEFAULT 0 COMMENT 'Tamanho do arquivo em bytes',
    process_id INT NULL COMMENT 'PID do processo ffmpeg',

    -- Índices para otimização
    INDEX idx_codigo_stm (codigo_stm),
    INDEX idx_status (status),
    INDEX idx_data_inicio (data_inicio)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Sessões de gravação de transmissões';

-- Consultas úteis
--
-- Listar gravações em andamento:
-- SELECT * FROM recording_sessions WHERE status = 'recording';
--
-- Listar gravações de um usuário:
-- SELECT * FROM recording_sessions WHERE codigo_stm = ? ORDER BY data_inicio DESC;
--
-- Estatísticas de gravações:
-- SELECT
--     status,
--     COUNT(*) as total,
--     SUM(tamanho_arquivo) as tamanho_total
-- FROM recording_sessions
-- GROUP BY status;
