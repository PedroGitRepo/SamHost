const db = require('../config/database');

class StreamingControlService {

    /* =====================================================
     * BUSCAR DADOS DO STREAMING
     * ===================================================== */
    async getStreamingData(login) {
        const [streamingRows] = await db.execute(
            'SELECT * FROM streamings WHERE usuario = ?',
            [login]
        );

        if (!streamingRows.length) {
            throw new Error('Streaming não encontrado');
        }

        const streaming = streamingRows[0];

        const [serverRows] = await db.execute(
            'SELECT * FROM wowza_servers WHERE codigo = ?',
            [streaming.codigo_servidor]
        );

        if (!serverRows.length) {
            throw new Error('Servidor não encontrado');
        }

        const server = serverRows[0];

        if (server.status === 'off') {
            throw new Error('Servidor em manutenção');
        }

        return { streaming, server };
    }

    /* =====================================================
     * STATUS DO STREAMING
     * ===================================================== */
    async checkStreamingStatus(login) {
        try {
            await this.getStreamingData(login);

            // No Wowza 4.9+, streaming sempre pronto
            return {
                status: 'ready'
            };

        } catch {
            return { status: 'unavailable' };
        }
    }

    /* =====================================================
     * LIGAR STREAMING (NO-OP)
     * ===================================================== */
    async ligarStreaming(login) {
        try {
            const { streaming } = await this.getStreamingData(login);

            await this.logStreamingAction(
                streaming.codigo,
                'Streaming solicitado (Wowza 4.9+ auto-start)'
            );

            return {
                success: true,
                message: 'Streaming disponível automaticamente'
            };

        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /* =====================================================
     * DESLIGAR STREAMING (NO-OP)
     * ===================================================== */
    async desligarStreaming(login) {
        try {
            const { streaming } = await this.getStreamingData(login);

            await this.logStreamingAction(
                streaming.codigo,
                'Streaming liberado (Wowza 4.9+ não exige stop)'
            );

            return {
                success: true,
                message: 'Streaming não requer desligamento'
            };

        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /* =====================================================
     * REINICIAR STREAMING (NO-OP)
     * ===================================================== */
    async reiniciarStreaming(login) {
        return this.ligarStreaming(login);
    }

    /* =====================================================
     * RECARREGAR PLAYLISTS / AGENDAMENTOS (SMIL)
     * ===================================================== */
    async recarregarPlaylistsAgendamentos(login) {
        try {
            const { streaming } = await this.getStreamingData(login);

            // SMIL é recarregado automaticamente ao salvar
            await this.logStreamingAction(
                streaming.codigo,
                'SMIL atualizado (reload automático Wowza 4.9+)'
            );

            return {
                success: true,
                message: 'SMIL atualizado. Wowza recarrega automaticamente.'
            };

        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /* =====================================================
     * LOGS
     * ===================================================== */
    async logStreamingAction(streamingCodigo, acao) {
        try {
            await db.execute(
                'INSERT INTO logs_streamings (codigo_stm, acao, data_hora) VALUES (?, ?, NOW())',
                [streamingCodigo, acao]
            );
        } catch {}
    }
}

module.exports = new StreamingControlService();
