const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const SSHManager = require('./SSHManager');
const db = require('./database');

class YouTubeDownloader {
    constructor() {
        this.activeDownloads = new Map();
        this.downloadQueue = [];
        this.maxConcurrentDownloads = 2;
        this.tempDir = '/tmp/youtube-downloads';
        
        this.initializeTempDir();
        this.startQueueProcessor();
    }

    async initializeTempDir() {
        try {
            await fs.mkdir(this.tempDir, { recursive: true });
            console.log(`📁 Diretório temporário criado: ${this.tempDir}`);
        } catch (error) {
            console.error('Erro ao criar diretório temporário:', error);
        }
    }

    // =====================
    // URL helpers
    // =====================
    validateYouTubeUrl(url) {
        const patterns = [
            /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
            /^(https?:\/\/)?(www\.)?(youtu\.be\/)([a-zA-Z0-9_-]{11})/,
            /^(https?:\/\/)?(www\.)?(youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
            /^(https?:\/\/)?(www\.)?(youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/
        ];
        return patterns.some(pattern => pattern.test(url));
    }

    extractVideoId(url) {
        const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/);
        return match ? match[1] : null;
    }

    // =====================
    // Info
    // =====================
    async getVideoInfo(url) {
        try {
            console.log(`📋 Obtendo informações do vídeo: ${url}`);

            await this.assertYtDlp();

            const ytDlpProcess = spawn('yt-dlp', [
                '--print-json',
                '--no-download',
                '--no-playlist',
                url
            ]);

            let stdout = '';
            let stderr = '';

            ytDlpProcess.stdout.on('data', d => stdout += d.toString());
            ytDlpProcess.stderr.on('data', d => stderr += d.toString());

            return await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    ytDlpProcess.kill();
                    reject(new Error('Timeout ao obter informações do vídeo (>30s)'));
                }, 30000);

                ytDlpProcess.on('close', (code) => {
                    clearTimeout(timeout);
                    if (code === 0 && stdout) {
                        try {
                            const info = JSON.parse(stdout.trim());
                            const sanitizedTitle = (info.title || 'Video_do_YouTube')
                                .replace(/[^a-zA-Z0-9\s\-_]/g, '')
                                .replace(/\s+/g, '_')
                                .substring(0, 100);

                            resolve({
                                id: info.id || this.extractVideoId(url) || 'unknown',
                                title: info.title || 'Video do YouTube',
                                sanitized_title: sanitizedTitle,
                                duration: info.duration || 0,
                                filesize: info.filesize || info.filesize_approx || 0,
                                ext: info.ext || 'mp4',
                                uploader: info.uploader || 'Unknown',
                                upload_date: info.upload_date || '',
                                view_count: info.view_count || 0,
                                description: info.description || '',
                                thumbnail: info.thumbnail || '',
                                webpage_url: info.webpage_url || url
                            });
                        } catch (e) {
                            reject(new Error('Erro ao analisar informações do vídeo'));
                        }
                    } else {
                        const errorMsg = stderr.includes('Video unavailable') ? 'Vídeo não disponível ou removido' :
                            stderr.includes('Private video') ? 'Vídeo privado' :
                            stderr.includes('Sign in to confirm') ? 'Vídeo requer confirmação de idade' :
                            stderr.includes('not available') ? 'Vídeo não disponível na sua região' :
                            stderr.includes('Requested format') ? 'Formato solicitado não disponível' :
                            'Erro ao acessar vídeo do YouTube';
                        reject(new Error(errorMsg));
                    }
                });

                ytDlpProcess.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(new Error(`Erro no yt-dlp: ${err.message}`));
                });
            });
        } catch (error) {
            console.error('Erro ao obter informações do vídeo:', error);
            throw error;
        }
    }

    // =====================
    // Download (MP4 garantido)
    // =====================
    async downloadVideo(userId, url, destinationFolder, options = {}) {
        const {
            quality = 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]',
            format = 'mp4',
            audio_quality = 'best'
        } = options;

        if (this.activeDownloads.has(userId)) {
            throw new Error('Já existe um download ativo para este usuário');
        }

        await this.assertYtDlp();
        await this.assertFfmpeg();

        const videoInfo = await this.getVideoInfo(url);
        const estimatedSizeMB = Math.ceil((videoInfo.filesize || 50 * 1024 * 1024) / (1024 * 1024));

        // Pasta destino
        let folderRows = await db.execute(
            'SELECT id as codigo, nome_sanitizado as identificacao, servidor_id as codigo_servidor, espaco, espaco_usado FROM folders WHERE id = ?',
            [destinationFolder]
        );

        if (folderRows[0].length === 0) {
            folderRows = await db.execute(
                'SELECT codigo, identificacao, codigo_servidor, espaco, espaco_usado FROM streamings WHERE codigo = ? AND codigo_cliente = ?',
                [destinationFolder, userId]
            );
        }

        if (folderRows[0].length === 0) {
            throw new Error('Pasta de destino não encontrada');
        }

        const folderData = folderRows[0][0];
        const folderName = folderData.identificacao;
        const serverId = folderData.codigo_servidor || 1;

        // Espaço do usuário
        const [userRows] = await db.execute(
            `SELECT
                s.espaco as total_space,
                COALESCE((SELECT SUM(tamanho_arquivo)/(1024*1024) FROM videos WHERE codigo_cliente=?), 0) as used_space
             FROM streamings s WHERE s.codigo_cliente=? LIMIT 1`,
            [userId, userId]
        );

        const totalSpace = parseFloat(userRows[0]?.total_space) || 1000;
        const usedSpace = parseFloat(userRows[0]?.used_space) || 0;
        const availableSpace = totalSpace - usedSpace;

        if (availableSpace < 100) {
            throw new Error(`Espaço insuficiente. Disponível: ${Math.round(availableSpace)}MB`);
        }
        if (estimatedSizeMB > availableSpace) {
            throw new Error(`Arquivo muito grande (${estimatedSizeMB}MB). Disponível: ${Math.round(availableSpace)}MB`);
        }

        const userLogin = await this.getUserLogin(userId);
        const fileName = `${videoInfo.sanitized_title}.mp4`;
        const tempFilePath = path.join(this.tempDir, `${userId}_${fileName}`);
        const remotePath = `/home/streaming/${userLogin}/${folderName}/${fileName}`;

        const downloadData = {
            url,
            videoInfo,
            fileName,
            tempFilePath,
            remotePath,
            startTime: new Date(),
            status: 'downloading',
            progress: 0,
            serverId,
            folderId: destinationFolder,
            folderName
        };

        this.activeDownloads.set(userId, downloadData);

        const ytDlpArgs = [
            '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]',
            '--merge-output-format', 'mp4',
            '--remux-video', 'mp4',
            '--output', tempFilePath,
            '--no-playlist',
            '--embed-metadata',
            '--no-warnings',
            '--newline',
            url
        ];

        const downloadProcess = spawn('yt-dlp', ytDlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        downloadData.process = downloadProcess;

        const onProgress = (buf) => {
            const out = buf.toString();
            const m = out.match(/(\d+\.?\d*)%/);
            if (m) downloadData.progress = parseFloat(m[1]);
        };

        downloadProcess.stdout.on('data', onProgress);
        downloadProcess.stderr.on('data', onProgress);

        downloadProcess.on('close', async (code) => {
            try {
                if (code !== 0) {
                    throw new Error(`Download falhou (código ${code})`);
                }

                downloadData.status = 'uploading';
                const stats = await fs.stat(tempFilePath);
                const fileSizeMB = Math.ceil(stats.size / (1024 * 1024));

                await SSHManager.createCompleteUserStructure(serverId, userLogin, {
                    bitrate: 2500,
                    espectadores: 100,
                    status_gravando: 'nao'
                });
                await SSHManager.createUserFolder(serverId, userLogin, folderName);
                await SSHManager.uploadFile(serverId, tempFilePath, remotePath);
                await fs.unlink(tempFilePath).catch(() => {});

                const relativePath = `${userLogin}/${folderName}/${fileName}`;
                const [result] = await db.execute(
                    `INSERT INTO videos (
                        nome, url, caminho, duracao, tamanho_arquivo,
                        codigo_cliente, pasta, bitrate_video, formato_original,
                        largura, altura, is_mp4, compativel, origem
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'mp4', 1920, 1080, 1, 'sim', 'youtube')`,
                    [
                        videoInfo.title,
                        `streaming/${relativePath}`,
                        remotePath,
                        videoInfo.duration,
                        stats.size,
                        userId,
                        destinationFolder,
                        2500
                    ]
                );

                await db.execute(
                    'UPDATE streamings SET espaco_usado = espaco_usado + ? WHERE codigo = ?',
                    [fileSizeMB, destinationFolder]
                );

                downloadData.status = 'completed';
                downloadData.videoId = result.insertId;
                downloadData.finalSize = stats.size;
            } catch (err) {
                console.error('Erro no pós-download:', err);
                downloadData.status = 'error';
                downloadData.error = err.message;
                await fs.unlink(tempFilePath).catch(() => {});
            } finally {
                // 🔥 limpeza obrigatória
                this.activeDownloads.delete(userId);
            }
        });

        downloadProcess.on('error', async (err) => {
            console.error('Erro no processo yt-dlp:', err);
            downloadData.status = 'error';
            downloadData.error = err.message;
            await fs.unlink(tempFilePath).catch(() => {});
            this.activeDownloads.delete(userId);
        });

        return {
            success: true,
            download_id: `${userId}_${Date.now()}`,
            video_info: videoInfo,
            estimated_size_mb: estimatedSizeMB
        };
    }

    // =====================
    // Status / Cancel
    // =====================
    getDownloadStatus(userId) {
        const d = this.activeDownloads.get(userId);
        if (!d) return { downloading: false, status: 'idle' };
        const uptime = Math.floor((Date.now() - d.startTime.getTime()) / 1000);
        return {
            downloading: d.status === 'downloading' || d.status === 'uploading',
            status: d.status,
            progress: d.progress || 0,
            filename: d.fileName,
            video_title: d.videoInfo?.title,
            uptime,
            error: d.error || null,
            final_size: d.finalSize || null,
            video_id: d.videoId || null
        };
    }

    async cancelDownload(userId) {
        const d = this.activeDownloads.get(userId);
        if (!d) return { success: true, message: 'Nenhum download ativo' };
        try {
            if (d.process?.pid) process.kill(d.process.pid, 'SIGTERM');
            if (d.tempFilePath) await fs.unlink(d.tempFilePath).catch(() => {});
            this.activeDownloads.delete(userId);
            return { success: true, message: 'Download cancelado' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // =====================
    // Utils
    // =====================
    async getUserLogin(userId) {
        try {
            const [rows] = await db.execute(
                'SELECT usuario, email FROM streamings WHERE codigo_cliente = ? LIMIT 1',
                [userId]
            );
            if (rows[0]?.usuario) return rows[0].usuario;
            if (rows[0]?.email) return rows[0].email.split('@')[0];
            return `user_${userId}`;
        } catch {
            return `user_${userId}`;
        }
    }

    async assertYtDlp() {
        await new Promise((resolve, reject) => {
            const p = spawn('which', ['yt-dlp']);
            let ok = false;
            p.stdout.on('data', () => ok = true);
            p.on('close', () => ok ? resolve() : reject(new Error('yt-dlp não instalado')));
        });
    }

    async assertFfmpeg() {
        await new Promise((resolve, reject) => {
            const p = spawn('which', ['ffmpeg']);
            let ok = false;
            p.stdout.on('data', () => ok = true);
            p.on('close', () => ok ? resolve() : reject(new Error('ffmpeg não instalado')));
        });
    }

    startQueueProcessor() {
        setInterval(() => {
            const now = Date.now();
            const maxAge = 60 * 60 * 1000;
            for (const [userId, d] of this.activeDownloads) {
                if (now - d.startTime.getTime() > maxAge) {
                    try { if (d.process?.pid) process.kill(d.process.pid, 'SIGTERM'); } catch {}
                    if (d.tempFilePath) fs.unlink(d.tempFilePath).catch(() => {});
                    this.activeDownloads.delete(userId);
                }
            }
        }, 5 * 60 * 1000);
    }

    async getRecentDownloads(userId, limit = 10) {
        try {
            const [rows] = await db.execute(
                `SELECT id, nome, duracao, tamanho_arquivo, data_upload
                 FROM videos WHERE codigo_cliente=? AND origem='youtube'
                 ORDER BY data_upload DESC LIMIT ?`,
                [userId, limit]
            );
            return rows.map(v => ({
                id: v.id,
                nome: v.nome,
                duracao: v.duracao,
                tamanho_mb: Math.ceil(v.tamanho_arquivo / (1024 * 1024)),
                data_download: v.data_upload
            }));
        } catch {
            return [];
        }
    }
}

module.exports = new YouTubeDownloader();