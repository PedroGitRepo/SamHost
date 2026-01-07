const SSHManager = require('../config/SSHManager');
const db = require('../config/database');
const DigestFetch = require('digest-fetch');

class StreamingControlService {
    constructor() {
        // Configurações da API REST (Wowza 4.9.6+)
        this.wowzaPort = 8087;
        this.wowzaUser = 'admin'; // Recomenda-se usar process.env.WOWZA_USER
        this.wowzaPass = 'wowza@123'; // Recomenda-se usar process.env.WOWZA_PASS
        this.client = new DigestFetch(this.wowzaUser, this.wowzaPass, { algorithm: 'MD5' });
    }

    /**
     * Helper genérico para chamadas REST API ao Wowza
     */
    async wowzaRequest(serverIp, path, method = 'GET', body = null) {
        const url = `http://${serverIp}:${this.wowzaPort}/v2/servers/_defaultServer_/${path}`;
        const options = {
            method: method,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            }
        };
        if (body) options.body = JSON.stringify(body);

        try {
            const response = await this.client.fetch(url, options);
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`Wowza API Error: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error(`Erro na requisição Wowza (${path}):`, error.message);
            throw error;
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
     * Verificar status básico (Substitui JMX getApplicationInstanceInfo)
     */
    async checkStreamingStatus(serverIp, serverPassword, login) {
        try {
            // Verifica estatísticas em tempo real da aplicação
            const data = await this.wowzaRequest(serverIp, `vhosts/_defaultVHost_/applications/${login}/monitoring/current`);
            
            // Se a aplicação responder e tiver uptime, está "loaded"
            if (data && data.uptime > 0) {
                return { status: 'loaded' };
            }
            return { status: 'unloaded' };
        } catch (error) {
            return { status: 'unloaded' };
        }
    }

    /**
     * Ligar streaming (Substitui startAppInstance)
     */
    async ligarStreaming(login) {
        try {
            const { streaming, server } = await this.getStreamingData(login);
            
            // Na REST API, o restart força o carregamento da App
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
     * Desligar streaming (Substitui shutdownAppInstance)
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

            // Bloqueio de arquivo (SSH necessário)
            await SSHManager.executeCommand(server.codigo, `mv -f /usr/local/WowzaMediaServer/conf/${streaming.login}/Application.xml /usr/local/WowzaMediaServer/conf/${streaming.login}/Application.xml.lock`);

            // Desliga a instância via API
            await this.desligarStreaming(login);

            await db.execute('UPDATE streamings SET status = "2" WHERE codigo = ?', [streaming.codigo]);
            await this.logAction(`[${streaming.login}] Streaming bloqueado via Admin`);

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

            // Desbloqueio de arquivo (SSH necessário)
            await SSHManager.executeCommand(server.codigo, `mv -f /usr/local/WowzaMediaServer/conf/${streaming.login}/Application.xml.lock /usr/local/WowzaMediaServer/conf/${streaming.login}/Application.xml`);

            // Inicia via API
            await this.ligarStreaming(login);

            await db.execute('UPDATE streamings SET status = "1" WHERE codigo = ?', [streaming.codigo]);
            await this.logAction(`[${streaming.login}] Streaming desbloqueado via Admin`);

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

            // 1. Verificar se há fonte de vídeo ativa (Incoming Streams)
            const incoming = await this.wowzaRequest(server.ip, `vhosts/_defaultVHost_/applications/${login}/instances/_definst_/incomingstreams`);
            const isLive = incoming && incoming.incomingStreams && incoming.incomingStreams.length > 0;

            // 2. Buscar total de conexões (Audiência)
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
     * Recarregar playlists/agendamentos (ModuleSchedule)
     */
    /**
     * Recarregar playlists/agendamentos (ModuleSchedule)
     * Ajustado para evitar o erro 'undefined'
     */
    async recarregarPlaylistsAgendamentos(login) {
        try {
            const { streaming, server } = await this.getStreamingData(login);
            
            // Certifique-se que o IP do servidor está acessível na porta 555
            const url = `http://${server.ip}:555/schedules?appName=${login}&action=reloadSchedule`;
            
            console.log(`[RELOAD] Tentando: ${url}`);

            const response = await this.client.fetch(url, { 
                method: 'GET',
                timeout: 5000 // Timeout de 5 segundos
            });

            if (!response) {
                throw new Error('Sem resposta do servidor Wowza na porta 555');
            }

            const text = await response.text();
            console.log(`[RELOAD] Resposta do Wowza: ${text}`);

            if (text.includes('DONE') || text.includes('Success')) {
                await this.logStreamingAction(streaming.codigo, 'Playlists recarregadas via HTTP');
                return { success: true, message: 'Playlists recarregadas com sucesso' };
            } else {
                throw new Error(`Wowza retornou: ${text || 'Resposta Vazia'}`);
            }
        } catch (error) {
            // Aqui evitamos o 'undefined' garantindo que sempre haja uma string
            const errorMsg = error.message || error.toString() || 'Erro desconhecido na comunicação';
            console.error(`❌ Erro ao recarregar playlists (${login}):`, errorMsg);
            
            return { 
                success: false, 
                message: 'Não foi possível recarregar as playlists', 
                error: errorMsg 
            };
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