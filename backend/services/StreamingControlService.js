const db = require('../config/database');
const axios = require('axios');

class StreamingControlService {

    /* =====================================================
     * CONFIGURAÇÕES WOWZA
     * ===================================================== */
    getWowzaConfig(server) {
        return {
            baseURL: `http://${server.ip}:${server.api_port || 8087}/v2`,
            auth: {
                username: process.env.WOWZA_API_USER || 'admin',
                password: process.env.WOWZA_API_PASS || 'SENHA_REAL_AQUI'
            },
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'StreamingControlService/4.9+'
            },
            timeout: 10000
        };
    }

    async wowzaRequest(server, method, endpoint) {
        const config = this.getWowzaConfig(server);

        try {
            const response = await axios({
                method,
                url: `${config.baseURL}${endpoint}`,
                auth: config.auth,
                headers: config.headers
            });

            return response.data || {};
        } catch (error) {
            const msg = error.response
                ? `Wowza API ${error.response.status}: ${JSON.stringify(error.response.data)}`
                : error.message;
            throw new Error(msg);
        }
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

            return {
                status: data?.application?.status === 'started'
                    ? 'loaded'
                    : 'unloaded'
            };
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
            return { success: false, message: error.message };
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
            return { success: false, message: error.message };
        }
    }

    /* =====================================================
     * REINICIAR STREAMING
     * ===================================================== */
    async reiniciarStreaming(login) {
        await this.desligarStreaming(login);
        await new Promise(r => setTimeout(r, 1500));
        return this.ligarStreaming(login);
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
