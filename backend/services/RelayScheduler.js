const db = require('../config/database');
const SSHManager = require('../config/SSHManager');

class RelayScheduler {
  constructor() {
    this.checkInterval = 60000; // Verificar a cada minuto
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log('🕐 RelayScheduler iniciado');

    // Verificar agendamentos a cada minuto
    this.intervalId = setInterval(() => this.checkSchedules(), this.checkInterval);

    // Verificar uma vez na inicialização
    await this.checkSchedules();
  }

  async stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.isRunning = false;
    console.log('🛑 RelayScheduler parado');
  }

  async checkSchedules() {
    try {
      const now = new Date();
      const currentTime = now.toTimeString().slice(0, 5); // HH:MM
      const dayOfWeek = now.getDay(); // 0=domingo, 1=segunda, etc

      // Buscar agendamentos ativos
      const [schedules] = await db.execute(
        `SELECT * FROM relay_config
         WHERE status = 'agendado' AND frequencia IS NOT NULL
         LIMIT 100`
      );

      for (const schedule of schedules) {
        const shouldExecute = this.shouldExecuteSchedule(schedule, currentTime, dayOfWeek);

        if (shouldExecute) {
          console.log(`⏰ Executando agendamento de relay #${schedule.codigo}`);
          await this.executeRelay(schedule);
        }
      }
    } catch (error) {
      console.error('Erro ao verificar agendamentos de relay:', error);
    }
  }

  shouldExecuteSchedule(schedule, currentTime, dayOfWeek) {
    try {
      const scheduleTime = schedule.hora || '00:00';

      // Tipo 1: Data específica
      if (schedule.frequencia === 1) {
        if (!schedule.data) return false;

        const scheduleDate = new Date(schedule.data);
        const today = new Date();

        if (
          scheduleDate.getFullYear() === today.getFullYear() &&
          scheduleDate.getMonth() === today.getMonth() &&
          scheduleDate.getDate() === today.getDate() &&
          scheduleTime === currentTime
        ) {
          return true;
        }
      }
      // Tipo 2: Diariamente
      else if (schedule.frequencia === 2) {
        return scheduleTime === currentTime;
      }
      // Tipo 3: Dias da semana
      else if (schedule.frequencia === 3) {
        if (!schedule.dias) return false;

        // dias vem como string separada por vírgula: "1,3,5"
        const daysArray = schedule.dias
          .split(',')
          .map(d => parseInt(d.trim()))
          .filter(d => !isNaN(d));

        // Converter dayOfWeek (0=domingo) para formato do DB (1=segunda, 0=domingo)
        const scheduleDay = dayOfWeek === 0 ? 7 : dayOfWeek;

        if (daysArray.includes(scheduleDay) && scheduleTime === currentTime) {
          return true;
        }
      }

      return false;
    } catch (error) {
      console.error('Erro ao verificar se deve executar:', error);
      return false;
    }
  }

  async executeRelay(schedule) {
    try {
      console.log(`🎯 Iniciando relay agendado: ${schedule.url_origem}`);

      const userId = schedule.codigo_stm;
      const serverId = schedule.servidor_id || 1;

      // Buscar dados do usuário
      const [userRows] = await db.execute(
        'SELECT usuario FROM users WHERE id = ?',
        [userId]
      );

      if (userRows.length === 0) {
        console.error(`Usuário ${userId} não encontrado`);
        return;
      }

      const userLogin = userRows[0].usuario;

      // Buscar dados do streaming para autenticação
      const [streamingData] = await db.execute(
        'SELECT autenticar_live, senha_transmissao, aplicacao FROM streamings WHERE codigo_cliente = ? LIMIT 1',
        [userId]
      );

      const streamingInfo = streamingData.length > 0 ? streamingData[0] : {};
      const autenticar = streamingInfo.autenticar_live === 'sim'
        ? `${userLogin}:${streamingInfo.senha_transmissao}@`
        : '';
      const chave = streamingInfo.aplicacao === 'tvstation' ? 'live' : userLogin;

      const outputUrl = `rtmp://${autenticar}localhost:1935/${userLogin}/${chave}`;
      const relay_url = schedule.url_origem;

      // Finalizar relay anterior se existir
      const killCommand = `screen -ls | grep -o '[0-9]*\\.${userLogin}_relay' | xargs -I{} screen -X -S {} quit`;

      try {
        await SSHManager.executeCommand(serverId, `echo OK;${killCommand}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (killError) {
        console.warn(`⚠️ Aviso ao finalizar relay anterior: ${killError.message}`);
      }

      // Iniciar novo relay
      const ffmpegCommand = `/usr/local/bin/ffmpeg -re -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 2 -i '${relay_url}' -c:v copy -c:a copy -bsf:a aac_adtstoasc -preset medium -threads 1 -f flv '${outputUrl}'`;
      const screenCommand = `screen -dmS ${userLogin}_relay bash -c '${ffmpegCommand}; exec sh'`;

      const startResult = await SSHManager.executeCommand(serverId, `echo OK;${screenCommand}`);

      if (!startResult.success) {
        throw new Error(`Falha ao executar comando SSH: ${startResult.stderr}`);
      }

      console.log(`⏳ Aguardando 10 segundos para estabilização...`);
      await new Promise(resolve => setTimeout(resolve, 10000));

      // Verificar se relay está rodando
      const checkCommand = `screen -ls | grep ${userLogin}_relay`;
      const checkResult = await SSHManager.executeCommand(serverId, checkCommand);

      const isRunning = checkResult.success && checkResult.stdout && checkResult.stdout.includes(`${userLogin}_relay`);

      if (isRunning) {
        console.log(`✅ Relay agendado executado com sucesso`);

        // Atualizar status
        await db.execute(
          'UPDATE relay_config SET status = "ativo", data_inicio = NOW() WHERE codigo = ?',
          [schedule.codigo]
        );
      } else {
        throw new Error('Relay não iniciou corretamente');
      }
    } catch (error) {
      console.error(`❌ Erro ao executar relay agendado:`, error);

      // Atualizar com erro
      await db.execute(
        'UPDATE relay_config SET status = "erro", erro_detalhes = ? WHERE codigo = ?',
        [error.message, schedule.codigo]
      );
    }
  }
}

module.exports = new RelayScheduler();
