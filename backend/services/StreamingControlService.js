const SSHManager = require('../config/SSHManager');
const db = require('../config/database');
const DigestFetch = require('digest-fetch');

class StreamingControlService {
    constructor() {
        this.wowzaPort = 8087;
        this.wowzaUser = 'admin';
        this.wowzaPass = 'Wowza@123';
        // Criamos o Token Base64 para autenticação Basic
        this.authHeader = 'Basic ' + Buffer.from(`${this.wowzaUser}:${this.wowzaPass}`).toString('base64');
    }

    async wowzaRequest(serverIp, path, method = 'GET', body = null) {
        const url = `http://${serverIp}:${this.wowzaPort}/v2/servers/_defaultServer_/${path}`;
        const options = {
            method: method,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': this.authHeader // Enviando o login fixo aqui
            }
        };
        if (body) options.body = JSON.stringify(body);

        try {
            const fetch = require('node-fetch'); // Usando fetch padrão
            const response = await fetch(url, options);

            if (response.status === 401) throw new Error("401 Unauthorized - Verifique admin.password");
            if (!response.ok) return { success: false, status: response.status };

            return await response.json();
        } catch (error) {
            console.error(`Erro Wowza: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    /**
     * Buscar dados do streaming e servidor no banco de dados
     */
    async getStreamingData(login) {
        const [streamingRows] = await db.execute('SELECT * FROM streamings WHERE usuario = ?', [login]);
        if (streamingRows.length === 0) throw new Error('Streaming não encontrado');

        const streaming = streamingRows[0];
        const [serverRows] = await db.execute('SELECT * FROM wowza_servers WHERE codigo = ?', [streaming.codigo_servidor]);
        if (serverRows.length === 0) throw new Error('Servidor não encontrado');

        const server = serverRows[0];
        if (server.status === 'off') throw new Error('Servidor em manutenção');

        return { streaming, server };
    }

    /**
     * Verificar status básico
     */
    async checkStreamingStatus(serverIp, serverPassword, login) {
        try {
            const data = await this.wowzaRequest(serverIp, `vhosts/_defaultVHost_/applications/${login}/monitoring/current`);
            if (data && data.uptime > 0) {
                return { status: 'loaded' };
            }
            return { status: 'unloaded' };
        } catch (error) {
            return { status: 'unloaded' };
        }
    }

    /**
     * Ligar streaming
     */
    async ligarStreaming(login) {
        try {
            const { streaming, server } = await this.getStreamingData(login);
            const result = await this.wowzaRequest(server.ip, `vhosts/_defaultVHost_/applications/${login}/actions/restart`, 'PUT');

            if (result && result.success) {
                await this.logStreamingAction(streaming.codigo, 'Streaming ligado via REST API');
                return { success: true, message: 'Streaming ligado com sucesso' };
            }
            throw new Error('Não foi possível iniciar a aplicação');
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Desligar streaming
     */
    async desligarStreaming(login) {
        try {
            const { streaming, server } = await this.getStreamingData(login);
            const result = await this.wowzaRequest(server.ip, `vhosts/_defaultVHost_/applications/${login}/actions/shutdown`, 'PUT');

            if (result && result.success) {
                await this.logStreamingAction(streaming.codigo, 'Streaming desligado via REST API');
                return { success: true, message: 'Streaming desligado com sucesso' };
            }
            throw new Error('Erro ao desligar streaming');
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Reiniciar streaming
     */
    async reiniciarStreaming(login) {
        try {
            const { streaming, server } = await this.getStreamingData(login);
            const result = await this.wowzaRequest(server.ip, `vhosts/_defaultVHost_/applications/${login}/actions/restart`, 'PUT');

            if (result && result.success) {
                await this.logStreamingAction(streaming.codigo, 'Streaming reiniciado via REST API');
                return { success: true, message: 'Streaming reiniciado com sucesso' };
            }
            throw new Error('Erro ao reiniciar streaming');
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Bloquear streaming
     */
    async bloquearStreaming(login, userType) {
        try {
            if (!userType || (userType !== 'admin' && userType !== 'revenda')) throw new Error('Acesso não autorizado');
            const { streaming, server } = await this.getStreamingData(login);

            // Bloqueio de arquivo ajustado para o novo caminho WowzaStreamingEngine
            await SSHManager.executeCommand(server.codigo, `mv -f ${this.wowzaPath}/conf/${streaming.usuario}/Application.xml ${this.wowzaPath}/conf/${streaming.usuario}/Application.xml.lock`);

            // Desliga a instância via API
            await this.desligarStreaming(login);

            await db.execute('UPDATE streamings SET status = "2" WHERE codigo = ?', [streaming.codigo]);
            await this.logAction(`[${streaming.usuario}] Streaming bloqueado via Admin`);

            return { success: true, message: 'Streaming bloqueado com sucesso' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Desbloquear streaming
     */
    async desbloquearStreaming(login, userType) {
        try {
            if (!userType || (userType !== 'admin' && userType !== 'revenda')) throw new Error('Acesso não autorizado');
            const { streaming, server } = await this.getStreamingData(login);

            // Desbloqueio de arquivo ajustado para o novo caminho WowzaStreamingEngine
            await SSHManager.executeCommand(server.codigo, `mv -f ${this.wowzaPath}/conf/${streaming.usuario}/Application.xml.lock ${this.wowzaPath}/conf/${streaming.usuario}/Application.xml`);

            // Inicia via API
            await this.ligarStreaming(login);

            await db.execute('UPDATE streamings SET status = "1" WHERE codigo = ?', [streaming.codigo]);
            await this.logAction(`[${streaming.usuario}] Streaming desbloqueado via Admin`);

            return { success: true, message: 'Streaming desbloqueado com sucesso' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Verificar Status Detalhado (Audiência e Fonte)
     */
    async verificarStatus(login, configData) {
        try {
            const { streaming, server } = await this.getStreamingData(login);

            const incoming = await this.wowzaRequest(server.ip, `vhosts/_defaultVHost_/applications/${login}/instances/_definst_/incomingstreams`);
            const isLive = incoming && incoming.incomingStreams && incoming.incomingStreams.length > 0;

            const monitoring = await this.wowzaRequest(server.ip, `vhosts/_defaultVHost_/applications/${login}/monitoring/current`);
            const totalConnections = monitoring ? monitoring.totalConnections : 0;

            if (isLive) {
                return {
                    status: 'aovivo',
                    message: 'Streaming ao vivo',
                    audiencia: totalConnections
                };
            }

            if (monitoring && monitoring.uptime > 0) {
                return {
                    status: 'ligado',
                    message: 'Streaming ligado (sem fonte)',
                    audiencia: totalConnections
                };
            }

            return { status: 'desligado', message: 'Streaming desligado', audiencia: 0 };

        } catch (error) {
            return { status: 'erro', message: error.message };
        }
    }

    /**
     * Recarregar playlists/agendamentos
     * Alterado para usar Restart via API (Porta 8087) por falta do plugin da porta 555
     */
    async recarregarPlaylistsAgendamentos(login) {
        try {
            const { streaming, server } = await this.getStreamingData(login);

            console.log(`[RELOAD] Reiniciando aplicação para atualizar playlist: ${login}`);

            // O restart força o Wowza a reler o arquivo SMIL e agendamentos
            const path = `vhosts/_defaultVHost_/applications/${login}/actions/restart`;
            const result = await this.wowzaRequest(server.ip, path, 'PUT');

            if (result && result.success) {
                await this.logStreamingAction(streaming.codigo, 'Playlist atualizada via Restart API');
                return { success: true, message: 'Playlists recarregadas com sucesso' };
            }
            throw new Error('Wowza API não confirmou o reinício');
        } catch (error) {
            console.error(`❌ Erro ao recarregar playlists (${login}):`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Logs
     */
    async logStreamingAction(streamingCodigo, acao) {
        try {
            await db.execute('INSERT INTO logs_streamings (codigo_stm, acao, data_hora) VALUES (?, ?, NOW())', [streamingCodigo, acao]);
        } catch (e) { console.error(e); }
    }

    async logAction(acao) {
        try {
            await db.execute('INSERT INTO logs (acao, data_hora) VALUES (?, NOW())', [acao]);
        } catch (e) { console.error(e); }
    }
}

module.exports = new StreamingControlService();