# Instruções para Configurar Logo em Playlists

## SQL para Criar as Colunas no Banco de Dados

Execute o seguinte SQL no seu banco de dados MySQL:

```sql
-- Adiciona configuração de logo para playlists
-- Permite que cada playlist tenha sua própria logo com configurações de posição, tamanho e opacidade

-- Adicionar colunas de logo na tabela playlists
ALTER TABLE playlists
ADD COLUMN IF NOT EXISTS logo_id INT NULL,
ADD COLUMN IF NOT EXISTS logo_posicao ENUM('topo-esquerda', 'topo-centro', 'topo-direita', 'centro-esquerda', 'centro', 'centro-direita', 'baixo-esquerda', 'baixo-centro', 'baixo-direita') DEFAULT 'topo-direita',
ADD COLUMN IF NOT EXISTS logo_tamanho ENUM('pequeno', 'medio', 'grande') DEFAULT 'medio',
ADD COLUMN IF NOT EXISTS logo_opacidade INT DEFAULT 100;

-- Adicionar chave estrangeira (se a tabela logos já existir)
-- ALTER TABLE playlists ADD CONSTRAINT fk_playlist_logo FOREIGN KEY (logo_id) REFERENCES logos(id) ON DELETE SET NULL;

-- Criar índice para melhor performance
CREATE INDEX IF NOT EXISTS idx_playlist_logo ON playlists(logo_id);
```

## Como Funciona

### 1. **Enviar Logos**
   - Vá para **Gerenciar Logos**
   - Faça upload de suas logos em formato PNG (preferencialmente com fundo transparente)
   - As logos ficam armazenadas no servidor e disponíveis para uso em playlists

### 2. **Configurar Logo na Playlist**
   - Vá para **Gerenciar Playlists**
   - Selecione uma playlist
   - Clique no botão **"Configurar Logo"** (botão laranja)
   - Configure:
     - **Logo**: Selecione um logo previamente enviado (ou deixe "Nenhum logo")
     - **Posição**: Escolha entre 9 posições disponíveis (cantos e centro)
     - **Tamanho**: Pequeno (10%), Médio (15%) ou Grande (20%)
     - **Opacidade**: De 0% (transparente) a 100% (opaco)
   - Clique em **"Salvar Configurações"**

### 3. **Transmitir com Logo**
   - Ao transmitir a playlist, todos os vídeos exibirão o logo configurado
   - O logo aparecerá na posição, tamanho e opacidade definidos
   - Cada playlist pode ter sua própria configuração de logo

## Observações

- **Opcional**: O logo é opcional. Você pode deixar uma playlist sem logo.
- **Por Playlist**: Cada playlist tem sua própria configuração de logo.
- **Todos os Vídeos**: O logo será aplicado a todos os vídeos da playlist durante a transmissão.
- **Formato Recomendado**: PNG com fundo transparente para melhor resultado.
- **Tamanho Recomendado**: 300x100 pixels.

## Resolução de Problemas

### O botão "Configurar Logo" não funciona?
- Certifique-se de que executou o SQL acima no banco de dados.
- Verifique se há logos cadastrados em "Gerenciar Logos".

### As logos não aparecem?
- Verifique se a logo foi enviada corretamente em "Gerenciar Logos".
- Certifique-se de que salvou as configurações na playlist.
- Verifique se a opacidade não está em 0%.

### Erro ao salvar configurações?
- Execute o SQL acima para criar as colunas necessárias.
- Reinicie o backend após executar o SQL.
