-- Adiciona configuração de logo para playlists
-- Permite que cada playlist tenha sua própria logo com configurações de posição, tamanho e opacidade

-- Adicionar coluna logo_id (referência ao logo cadastrado)
ALTER TABLE playlists
ADD COLUMN IF NOT EXISTS logo_id INT NULL,
ADD COLUMN IF NOT EXISTS logo_posicao ENUM('topo-esquerda', 'topo-centro', 'topo-direita', 'centro-esquerda', 'centro', 'centro-direita', 'baixo-esquerda', 'baixo-centro', 'baixo-direita') DEFAULT 'topo-direita',
ADD COLUMN IF NOT EXISTS logo_tamanho ENUM('pequeno', 'medio', 'grande') DEFAULT 'medio',
ADD COLUMN IF NOT EXISTS logo_opacidade INT DEFAULT 100,
ADD CONSTRAINT fk_playlist_logo FOREIGN KEY (logo_id) REFERENCES logos(id) ON DELETE SET NULL;

-- Criar índice para melhor performance
CREATE INDEX IF NOT EXISTS idx_playlist_logo ON playlists(logo_id);

-- Comentários explicativos
-- logo_id: ID do logo cadastrado (NULL = sem logo)
-- logo_posicao: Posição do logo no vídeo (9 posições possíveis)
-- logo_tamanho: Tamanho do logo (pequeno = 10%, medio = 15%, grande = 20%)
-- logo_opacidade: Opacidade do logo (0-100%)
