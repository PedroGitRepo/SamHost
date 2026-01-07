const db = require('../config/database');
const DigestFetch = require('digest-fetch');

class StreamingControlService {

    /* =====================================================
     * CONFIGURAÇÕES WOWZA
     * ===================================================== */
    getWowzaClient(server) {
        return new DigestFetch(
            process.env.WOWZA_API_USER || 'admin',
            process.env.WOWZA_API_PASS || 'admin',
            { algorithm: 'MD5' }
        );
    }

    getWowzaBaseUrl(server) {
        const host = server.ip;
        const port = server.api_port || 8087;
        return `http://${host}:${port}/v2`;
    }

    async wowzaRequest(server, method, endpoint) {
        const client = this.getWowzaClient(server);
        const url = `${this.getWowzaBaseUrl(server)}${endpoint}`;

        const response = await client.fetch(url, {
            method,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'StreamingControlService/4.9+'
            }
        });

        const text = await response.text();

        if (!response.ok) {
            throw new Error(
                `Wowza API ${response.status}: ${text}`
            );
        }

        return text ? JSON.parse(text) : {};
    }

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
            const { server } = await this.getStreamingData(login);

            const data = await this.wowzaRequest(
                server,
                'GET',
                `/servers/_defaultServer_/vhosts/_defaultVHost_/applications/${login}`
            );

            if (data?.application?.status === 'started') {
                return { status: 'loaded' };
            }

            return { status: 'unloaded' };

        } catch {
            return { status: 'unloaded' };
        }
    }

    /* =====================================================
     * LIGAR STREAMING
     * ===================================================== */
    async ligarStreaming(login) {
        try {
            const { streaming, server } = await this.getStreamingData(login);

            const status = await this.checkStreamingStatus(login);
            if (status.status === 'loaded') {
                return {
                    success: false,
                    alreadyActive: true,
                    message: 'Streaming já está ligado'
                };
            }

            await this.wowzaRequest(
                server,
                'PUT',
                `/servers/_defaultServer_/vhosts/_defaultVHost_/applications/${login}/actions/start`
            );

            await this.logStreamingAction(
                streaming.codigo,
                'Streaming ligado via Wowza REST API'
            );

            return { success: true };

        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
    }

    /* =====================================================
     * DESLIGAR STREAMING
     * ===================================================== */
    async desligarStreaming(login) {
        try {
            const { streaming, server } = await this.getStreamingData(login);

            const status = await this.checkStreamingStatus(login);
            if (status.status !== 'loaded') {
                return {
                    success: false,
                    alreadyInactive: true,
                    message: 'Streaming já está desligado'
                };
            }

            await this.wowzaRequest(
                server,
                'PUT',
                `/servers/_defaultServer_/vhosts/_defaultVHost_/applications/${login}/actions/stop`
            );

            await this.logStreamingAction(
                streaming.codigo,
                'Streaming desligado via Wowza REST API'
            );

            return { success: true };

        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
    }

    /* =====================================================
     * REINICIAR STREAMING
     * ===================================================== */
    async reiniciarStreaming(login) {
        try {
            await this.desligarStreaming(login);
            await new Promise(r => setTimeout(r, 1500));
            return await this.ligarStreaming(login);
        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
    }

    /* =====================================================
     * RECARREGAR PLAYLISTS / AGENDAMENTOS (SMIL)
     * ===================================================== */
    async recarregarPlaylistsAgendamentos(login) {
        try {
            const { streaming, server } = await this.getStreamingData(login);

            await this.wowzaRequest(
                server,
                'PUT',
                `/servers/_defaultServer_/vhosts/_defaultVHost_/applications/${login}/schedules/actions/reload`
            );

            await this.logStreamingAction(
                streaming.codigo,
                'Playlists/agendamentos recarregados sem reiniciar'
            );

            return {
                success: true,
                message: 'Playlists recarregadas com sucesso'
            };

        } catch (error) {
            return {
                success: false,
                message: error.message
            };
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

    async logAction(acao) {
        try {
            await db.execute(
                'INSERT INTO logs (acao, data_hora) VALUES (?, NOW())',
                [acao]
            );
        } catch {}
    }
}

module.exports = new StreamingControlService();
