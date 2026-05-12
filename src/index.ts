import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';
import { WhoopSync } from './sync.js';

interface ToolArguments {
	days?: number;
	full?: boolean;
}

const config = {
	clientId: process.env.WHOOP_CLIENT_ID ?? '',
	clientSecret: process.env.WHOOP_CLIENT_SECRET ?? '',
	redirectUri: process.env.WHOOP_REDIRECT_URI ?? 'http://localhost:3000/callback',
	dbPath: process.env.DB_PATH ?? './whoop.db',
	port: Number.parseInt(process.env.PORT ?? '3000', 10),
	mode: process.env.MCP_MODE ?? 'http',
};

const db = new WhoopDatabase(config.dbPath);
const client = new WhoopClient({
	clientId: config.clientId,
	clientSecret: config.clientSecret,
	redirectUri: config.redirectUri,
	onTokenRefresh: tokens => db.saveTokens(tokens),
});

const existingTokens = db.getTokens();
if (existingTokens) {
	client.setTokens(existingTokens);
}

const sync = new WhoopSync(client, db);

const SESSION_TTL_MS = 30 * 60 * 1000;
const transports = new Map<string, { transport: StreamableHTTPServerTransport; lastAccess: number }>();

function cleanupStaleSessions(): void {
	const now = Date.now();
	for (const [sessionId, session] of transports) {
		if (now - session.lastAccess > SESSION_TTL_MS) {
			session.transport.close().catch(() => {});
			transports.delete(sessionId);
		}
	}
}

setInterval(cleanupStaleSessions, 5 * 60 * 1000);

function formatDuration(millis: number | null): string {
	if (!millis) return 'N/A';
	const hours = Math.floor(millis / 3_600_000);
	const minutes = Math.floor((millis % 3_600_000) / 60_000);
	return `${hours}h ${minutes}m`;
}

function formatDate(isoString: string): string {
	return new Date(isoString).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
}

function getRecoveryZone(score: number): string {
	if (score >= 67) return 'Green (Well Recovered)';
	if (score >= 34) return 'Yellow (Moderate)';
	return 'Red (Needs Rest)';
}

function getStrainZone(strain: number): string {
	if (strain >= 18) return 'All Out (18-21)';
	if (strain >= 14) return 'High (14-17)';
	if (strain >= 10) return 'Moderate (10-13)';
	return 'Light (0-9)';
}

function validateDays(value: unknown): number {
	if (value === undefined || value === null) return 14;
	const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (Number.isNaN(num) || num < 1) return 14;
	return Math.min(num, 90);
}

function validateBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	return false;
}

function createMcpServer(): Server {
	const server = new Server(
		{ name: 'whoop-mcp-server', version: '1.0.0' },
		{ capabilities: { tools: {} } }
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'get_today',
				description: "Get today's Whoop data including recovery score, last night's sleep, and current strain.",
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'get_recovery_trends',
				description: 'Get recovery score trends over time, including HRV and resting heart rate patterns.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_sleep_analysis',
				description: 'Get detailed sleep analysis including duration, stages, efficiency, and sleep debt.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_strain_history',
				description: 'Get training strain history and workout data.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'sync_data',
				description: 'Manually trigger a data sync from Whoop.',
				inputSchema: {
					type: 'object',
					properties: { full: { type: 'boolean', description: 'Force a full 90-day sync (default: false)' } },
					required: [],
				},
			},
			{
				name: 'get_auth_url',
				description: 'Get the Whoop authorization URL to connect your account.',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async request => {
		const { name, arguments: args } = request.params;
		const typedArgs = (args ?? {}) as ToolArguments;

		try {
			const dataTools = ['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history'];
			if (dataTools.includes(name)) {
				const tokens = db.getTokens();
				if (!tokens) {
					return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
				}
				client.setTokens(tokens);
				try {
					await sync.smartSync();
				} catch {
					// Continue with cached data
				}
			}

			switch (name) {
				case 'get_today': {
					const recovery = db.getLatestRecovery();
					const sleep = db.getLatestSleep();
					const cycle = db.getLatestCycle();

					if (!recovery && !sleep && !cycle) {
						return { content: [{ type: 'text', text: 'No data available. Try running sync_data first.' }] };
					}

					let response = "# Today's Whoop Summary\n\n";

					if (recovery) {
						response += `## Recovery: ${recovery.recovery_score ?? 'N/A'}% ${recovery.recovery_score ? getRecoveryZone(recovery.recovery_score) : ''}\n`;
						response += `- **HRV**: ${recovery.hrv_rmssd?.toFixed(1) ?? 'N/A'} ms\n`;
						response += `- **Resting HR**: ${recovery.resting_hr ?? 'N/A'} bpm\n`;
						if (recovery.spo2) response += `- **SpO2**: ${recovery.spo2.toFixed(1)}%\n`;
						if (recovery.skin_temp) response += `- **Skin Temp**: ${recovery.skin_temp.toFixed(1)}°C\n`;
						response += '\n';
					}

					if (sleep) {
						const totalSleep = (sleep.total_in_bed_milli ?? 0) - (sleep.total_awake_milli ?? 0);
						response += `## Last Night's Sleep\n`;
						response += `- **Total Sleep**: ${formatDuration(totalSleep)}\n`;
						response += `- **Performance**: ${sleep.sleep_performance?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Efficiency**: ${sleep.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Stages**: Light ${formatDuration(sleep.total_light_milli)}, Deep ${formatDuration(sleep.total_deep_milli)}, REM ${formatDuration(sleep.total_rem_milli)}\n`;
						if (sleep.respiratory_rate) response += `- **Respiratory Rate**: ${sleep.respiratory_rate.toFixed(1)} breaths/min\n`;
						response += '\n';
					}

					if (cycle) {
						response += `## Current Strain\n`;
						response += `- **Day Strain**: ${cycle.strain?.toFixed(1) ?? 'N/A'} ${cycle.strain ? getStrainZone(cycle.strain) : ''}\n`;
						if (cycle.kilojoule) response += `- **Calories**: ${Math.round(cycle.kilojoule / 4.184)} kcal\n`;
						if (cycle.avg_hr) response += `- **Avg HR**: ${cycle.avg_hr} bpm\n`;
						if (cycle.max_hr) response += `- **Max HR**: ${cycle.max_hr} bpm\n`;
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_recovery_trends': {
					const days = validateDays(typedArgs.days);
					const trends = db.getRecoveryTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No recovery data available for the requested period.' }] };
					}

					let response = `# Recovery Trends (Last ${days} Days)\n\n`;
					response += '| Date | Recovery | HRV | RHR |\n|------|----------|-----|-----|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.recovery_score}% | ${day.hrv?.toFixed(1) ?? 'N/A'} ms | ${day.rhr ?? 'N/A'} bpm |\n`;
					}

					const avgRecovery = trends.reduce((sum, d) => sum + (d.recovery_score || 0), 0) / trends.length;
					const avgHrv = trends.reduce((sum, d) => sum + (d.hrv || 0), 0) / trends.length;
					const avgRhr = trends.reduce((sum, d) => sum + (d.rhr || 0), 0) / trends.length;

					response += `\n## Averages\n- **Recovery**: ${avgRecovery.toFixed(0)}%\n- **HRV**: ${avgHrv.toFixed(1)} ms\n- **RHR**: ${avgRhr.toFixed(0)} bpm\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_sleep_analysis': {
					const days = validateDays(typedArgs.days);
					const trends = db.getSleepTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No sleep data available for the requested period.' }] };
					}

					let response = `# Sleep Analysis (Last ${days} Days)\n\n`;
					response += '| Date | Duration | Performance | Efficiency |\n|------|----------|-------------|------------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.total_sleep_hours?.toFixed(1) ?? 'N/A'}h | ${day.performance?.toFixed(0) ?? 'N/A'}% | ${day.efficiency?.toFixed(0) ?? 'N/A'}% |\n`;
					}

					const avgDuration = trends.reduce((sum, d) => sum + (d.total_sleep_hours || 0), 0) / trends.length;
					const avgPerf = trends.reduce((sum, d) => sum + (d.performance || 0), 0) / trends.length;
					const avgEff = trends.reduce((sum, d) => sum + (d.efficiency || 0), 0) / trends.length;

					response += `\n## Averages\n- **Duration**: ${avgDuration.toFixed(1)} hours\n- **Performance**: ${avgPerf.toFixed(0)}%\n- **Efficiency**: ${avgEff.toFixed(0)}%\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_strain_history': {
					const days = validateDays(typedArgs.days);
					const trends = db.getStrainTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No strain data available for the requested period.' }] };
					}

					let response = `# Strain History (Last ${days} Days)\n\n`;
					response += '| Date | Strain | Calories |\n|------|--------|----------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.strain?.toFixed(1) ?? 'N/A'} | ${day.calories ?? 'N/A'} kcal |\n`;
					}

					const avgStrain = trends.reduce((sum, d) => sum + (d.strain || 0), 0) / trends.length;
					const avgCalories = trends.reduce((sum, d) => sum + (d.calories || 0), 0) / trends.length;

					response += `\n## Averages\n- **Daily Strain**: ${avgStrain.toFixed(1)}\n- **Daily Calories**: ${Math.round(avgCalories)} kcal\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'sync_data': {
					const tokens = db.getTokens();
					if (!tokens) {
						return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
					}
					client.setTokens(tokens);

					const full = validateBoolean(typedArgs.full);
					let stats;

					if (full) {
						stats = await sync.syncDays(90);
					} else {
						const result = await sync.smartSync();
						if (result.type === 'skip') {
							return { content: [{ type: 'text', text: 'Data is already up to date (synced within the last hour).' }] };
						}
						stats = result.stats;
					}

					return {
						content: [{
							type: 'text',
							text: `Sync complete!\n- Cycles: ${stats?.cycles}\n- Recoveries: ${stats?.recoveries}\n- Sleeps: ${stats?.sleeps}\n- Workouts: ${stats?.workouts}`,
						}],
					};
				}

				case 'get_auth_url': {
					const scopes = ['read:profile', 'read:body_measurement', 'read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline'];
					const url = client.getAuthorizationUrl(scopes);
					return {
						content: [{
							type: 'text',
							text: `To authorize with Whoop:\n\n1. Visit: ${url}\n2. Log in and authorize\n3. You'll be redirected back automatically\n\nRedirect URI: ${config.redirectUri}`,
						}],
					};
				}

				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
		}
	});

	return server;
}

async function main(): Promise<void> {
	if (config.mode === 'stdio') {
		const server = createMcpServer();
		const transport = new StdioServerTransport();
		await server.connect(transport);
		process.stderr.write('Whoop MCP server running on stdio\n');
	} else {
		const app = express();
		app.use(express.json());

		// Whoop sport_id → human-readable name (common subset)
		const SPORT_NAMES: Record<number, string> = {
			0: "Running", 1: "Cycling", 11: "Basketball", 16: "Volleyball",
			17: "Soccer", 18: "Boxing", 24: "Olympic Weightlifting",
			39: "Mountain Biking", 42: "Skiing", 43: "Snowboarding",
			44: "Surfing", 45: "Walking", 47: "Yoga", 48: "HIIT", 49: "Stairmaster",
			50: "Functional Fitness", 51: "Pilates", 52: "Stretching", 53: "Hiking",
			54: "Strength Trainer", 55: "Tennis", 56: "Squash", 57: "Pickleball",
			59: "Rowing", 60: "Climbing", 61: "Bouldering", 63: "Field Hockey",
			65: "Lacrosse", 66: "Rugby", 71: "Powerlifting", 76: "Tennis",
			96: "Pilates", 97: "Yoga", 98: "Stretching",
			102: "Baseball", 103: "Golf", 104: "Hockey", 105: "Weightlifting",
			121: "Pickleball", 122: "Meditation", 123: "Meditation",
		};

		app.get('/callback', async (req: Request, res: Response) => {
			const code = req.query.code as string | undefined;
			if (!code) {
				res.status(400).send('Missing authorization code');
				return;
			}

			try {
				const tokens = await client.exchangeCodeForTokens(code);
				db.saveTokens(tokens);
				sync.syncDays(90).catch(() => {});
				res.send('Authorization successful! You can close this window.');
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error('OAuth callback error:', msg);
				res.status(500).type('text/plain').send(
					`Authorization failed:\n\n${msg}\n\n---\nEnv check:\n` +
					`WHOOP_REDIRECT_URI=${process.env.WHOOP_REDIRECT_URI ?? '(unset)'}\n` +
					`WHOOP_CLIENT_ID=${(process.env.WHOOP_CLIENT_ID ?? '(unset)').slice(0,8)}...\n` +
					`WHOOP_CLIENT_SECRET=${process.env.WHOOP_CLIENT_SECRET ? '(set, ' + process.env.WHOOP_CLIENT_SECRET.length + ' chars)' : '(unset)'}`
				);
			}
		});

		app.get('/health', (_req: Request, res: Response) => {
			res.json({ status: 'ok', authenticated: Boolean(db.getTokens()) });
		});

		// REST endpoint for non-MCP clients (e.g. Donna) — returns latest Whoop data as JSON
		// Auth: Bearer <MCP_AUTH_TOKEN>
		app.get('/api/today', async (req: Request, res: Response) => {
			const authHeader = req.headers['authorization'] || '';
			const expected = process.env.MCP_AUTH_TOKEN;
			if (!expected) {
				res.status(500).json({ error: 'server_misconfigured', detail: 'MCP_AUTH_TOKEN not set' });
				return;
			}
			if (authHeader !== `Bearer ${expected}`) {
				res.status(401).json({ error: 'unauthorized' });
				return;
			}

			const tokens = db.getTokens();
			if (!tokens) {
				res.status(503).json({ error: 'not_authenticated', detail: 'Whoop OAuth not completed' });
				return;
			}
			client.setTokens(tokens);
			try {
				await sync.smartSync();
			} catch {
				// continue with cached data
			}

			const recovery = db.getLatestRecovery();
			const sleep = db.getLatestSleep();
			const cycle = db.getLatestCycle();

			res.json({
				as_of: new Date().toISOString(),
				endpoint: "today",
				recovery: recovery ? {
					score: recovery.recovery_score,
					hrv_rmssd_ms: recovery.hrv_rmssd,
					resting_hr_bpm: recovery.resting_hr,
					spo2: recovery.spo2,
					skin_temp_c: recovery.skin_temp,
				} : null,
				sleep: sleep ? {
					start: sleep.start_time,
					end: sleep.end_time,
					is_nap: sleep.is_nap === 1,
					total_in_bed_min: sleep.total_in_bed_milli ? Math.round(sleep.total_in_bed_milli / 60000) : null,
					total_awake_min: sleep.total_awake_milli ? Math.round(sleep.total_awake_milli / 60000) : null,
					total_sleep_min: sleep.total_in_bed_milli && sleep.total_awake_milli
						? Math.round((sleep.total_in_bed_milli - sleep.total_awake_milli) / 60000)
						: null,
					performance_pct: sleep.sleep_performance,
					efficiency_pct: sleep.sleep_efficiency,
					consistency_pct: sleep.sleep_consistency,
					light_min: sleep.total_light_milli ? Math.round(sleep.total_light_milli / 60000) : null,
					deep_min: sleep.total_deep_milli ? Math.round(sleep.total_deep_milli / 60000) : null,
					rem_min: sleep.total_rem_milli ? Math.round(sleep.total_rem_milli / 60000) : null,
					respiratory_rate: sleep.respiratory_rate,
					// Whoop "sleep coach" data — needed for "you owe X min of sleep" insights
					sleep_need: {
						baseline_min: sleep.sleep_needed_baseline_milli ? Math.round(sleep.sleep_needed_baseline_milli / 60000) : null,
						debt_min: sleep.sleep_needed_debt_milli ? Math.round(sleep.sleep_needed_debt_milli / 60000) : null,
						strain_bonus_min: sleep.sleep_needed_strain_milli ? Math.round(sleep.sleep_needed_strain_milli / 60000) : null,
					},
				} : null,
				strain: cycle ? {
					day_strain: cycle.strain,
					calories_kcal: cycle.kilojoule ? Math.round(cycle.kilojoule / 4.184) : null,
					avg_hr_bpm: cycle.avg_hr,
					max_hr_bpm: cycle.max_hr,
				} : null,
			});
		});

		// REST endpoint for trend queries — used by Luka /whoop skill for "past N days"
		// Auth: Bearer <MCP_AUTH_TOKEN>
		// Query: ?days=14 (default 14, max 90)
		app.get('/api/trends', async (req: Request, res: Response) => {
			const authHeader = req.headers['authorization'] || '';
			const expected = process.env.MCP_AUTH_TOKEN;
			if (!expected) {
				res.status(500).json({ error: 'server_misconfigured', detail: 'MCP_AUTH_TOKEN not set' });
				return;
			}
			if (authHeader !== `Bearer ${expected}`) {
				res.status(401).json({ error: 'unauthorized' });
				return;
			}

			const tokens = db.getTokens();
			if (!tokens) {
				res.status(503).json({ error: 'not_authenticated', detail: 'Whoop OAuth not completed' });
				return;
			}
			client.setTokens(tokens);
			try {
				await sync.smartSync();
			} catch {
				// continue with cached data
			}

			let days = parseInt(String(req.query.days ?? '14'), 10);
			if (!Number.isFinite(days) || days < 1) days = 14;
			if (days > 90) days = 90;

			const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
			const until = new Date().toISOString();
			const workouts = db.getWorkoutsByDateRange(since, until);

			res.json({
				as_of: new Date().toISOString(),
				endpoint: "trends",
				days,
				recovery: db.getRecoveryTrends(days),
				sleep: db.getSleepTrends(days),
				strain: db.getStrainTrends(days),
				workouts: workouts.map((w: any) => ({
					id: w.id,
					sport_id: w.sport_id,
					sport: w.sport_name ?? SPORT_NAMES[w.sport_id as number] ?? (w.sport_id === -1 ? "activity" : `sport_${w.sport_id}`),
					start: w.start_time,
					end: w.end_time,
					duration_min: w.start_time && w.end_time
						? Math.round((Date.parse(w.end_time) - Date.parse(w.start_time)) / 60000)
						: null,
					strain: w.strain,
					avg_hr: w.avg_hr,
					max_hr: w.max_hr,
					kilojoule: w.kilojoule,
					calories_kcal: w.kilojoule ? Math.round(w.kilojoule / 4.184) : null,
					hr_zone_min: {
						z0: w.zone_zero_milli ? Math.round(w.zone_zero_milli / 60000) : 0,
						z1: w.zone_one_milli ? Math.round(w.zone_one_milli / 60000) : 0,
						z2: w.zone_two_milli ? Math.round(w.zone_two_milli / 60000) : 0,
						z3: w.zone_three_milli ? Math.round(w.zone_three_milli / 60000) : 0,
						z4: w.zone_four_milli ? Math.round(w.zone_four_milli / 60000) : 0,
						z5: w.zone_five_milli ? Math.round(w.zone_five_milli / 60000) : 0,
					},
				})),
			});
		});

		// Debug: force sync + dump raw Whoop API workout response
		app.get('/api/debug/workouts-raw', async (req: Request, res: Response) => {
			const authHeader = req.headers['authorization'] || '';
			const expected = process.env.MCP_AUTH_TOKEN;
			if (!expected) { res.status(500).json({ error: 'server_misconfigured' }); return; }
			if (authHeader !== `Bearer ${expected}`) { res.status(401).json({ error: 'unauthorized' }); return; }

			const tokens = db.getTokens();
			if (!tokens) { res.status(503).json({ error: 'not_authenticated' }); return; }
			client.setTokens(tokens);

			const days = parseInt(String(req.query.days ?? '30'), 10);
			const end = new Date().toISOString();
			const start = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

			let whoopResp: any;
			let syncStats: any;
			let errMsg: string | null = null;
			try {
				whoopResp = await client.getAllWorkouts({ start, end });
			} catch (e: any) {
				errMsg = e?.message ?? String(e);
			}
			try {
				syncStats = await sync.syncDays(days);
			} catch (e: any) {
				if (!errMsg) errMsg = e?.message ?? String(e);
			}

			res.json({
				as_of: new Date().toISOString(),
				query_window: { start, end, days },
				whoop_api_returned_count: whoopResp ? whoopResp.length : null,
				whoop_api_sample: whoopResp && whoopResp.length ? whoopResp.slice(0, 2) : [],
				sync_stats: syncStats,
				db_workouts_after_sync: db.getWorkoutsByDateRange(start, end).length,
				error: errMsg,
			});
		});

		// Dedicated workouts endpoint with same auth+shape as /api/trends.workouts
		app.get('/api/workouts', async (req: Request, res: Response) => {
			const authHeader = req.headers['authorization'] || '';
			const expected = process.env.MCP_AUTH_TOKEN;
			if (!expected) { res.status(500).json({ error: 'server_misconfigured' }); return; }
			if (authHeader !== `Bearer ${expected}`) { res.status(401).json({ error: 'unauthorized' }); return; }

			const tokens = db.getTokens();
			if (!tokens) { res.status(503).json({ error: 'not_authenticated' }); return; }
			client.setTokens(tokens);
			try { await sync.smartSync(); } catch { /* cached */ }

			let days = parseInt(String(req.query.days ?? '14'), 10);
			if (!Number.isFinite(days) || days < 1) days = 14;
			if (days > 90) days = 90;

			const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
			const until = new Date().toISOString();
			const workouts = db.getWorkoutsByDateRange(since, until);

			res.json({
				as_of: new Date().toISOString(),
				endpoint: "workouts",
				days,
				count: workouts.length,
				workouts: workouts.map((w: any) => ({
					id: w.id,
					sport_id: w.sport_id,
					sport: w.sport_name ?? SPORT_NAMES[w.sport_id as number] ?? (w.sport_id === -1 ? "activity" : `sport_${w.sport_id}`),
					start: w.start_time,
					end: w.end_time,
					duration_min: w.start_time && w.end_time
						? Math.round((Date.parse(w.end_time) - Date.parse(w.start_time)) / 60000)
						: null,
					strain: w.strain,
					avg_hr: w.avg_hr,
					max_hr: w.max_hr,
					kilojoule: w.kilojoule,
					calories_kcal: w.kilojoule ? Math.round(w.kilojoule / 4.184) : null,
					hr_zone_min: {
						z0: w.zone_zero_milli ? Math.round(w.zone_zero_milli / 60000) : 0,
						z1: w.zone_one_milli ? Math.round(w.zone_one_milli / 60000) : 0,
						z2: w.zone_two_milli ? Math.round(w.zone_two_milli / 60000) : 0,
						z3: w.zone_three_milli ? Math.round(w.zone_three_milli / 60000) : 0,
						z4: w.zone_four_milli ? Math.round(w.zone_four_milli / 60000) : 0,
						z5: w.zone_five_milli ? Math.round(w.zone_five_milli / 60000) : 0,
					},
				})),
			});
		});

		app.all('/mcp', async (req: Request, res: Response) => {
			const sessionId = req.headers['mcp-session-id'] as string | undefined;

			if (req.method === 'DELETE' && sessionId && transports.has(sessionId)) {
				const session = transports.get(sessionId)!;
				await session.transport.close();
				transports.delete(sessionId);
				res.status(200).send('Session closed');
				return;
			}

			if (req.method === 'POST') {
				let transport: StreamableHTTPServerTransport;

				if (sessionId && transports.has(sessionId)) {
					const session = transports.get(sessionId)!;
					session.lastAccess = Date.now();
					transport = session.transport;
				} else {
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => crypto.randomUUID(),
						onsessioninitialized: newSessionId => {
							transports.set(newSessionId, { transport, lastAccess: Date.now() });
						},
					});

					const server = createMcpServer();
					await server.connect(transport);
				}

				await transport.handleRequest(req, res);
				return;
			}

			res.status(405).send('Method not allowed');
		});

		app.get('/sse', (_req: Request, res: Response) => {
			res.status(410).send('SSE endpoint deprecated. Use /mcp with Streamable HTTP transport.');
		});

		const server = app.listen(config.port, '0.0.0.0', () => {
			process.stdout.write(`Whoop MCP server running on http://0.0.0.0:${config.port}\n`);
		});

		const shutdown = (): void => {
			process.stdout.write('\nShutting down...\n');
			for (const [, session] of transports) {
				session.transport.close().catch(() => {});
			}
			transports.clear();
			db.close();
			server.close(() => process.exit(0));
		};

		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);
	}
}

main().catch(error => {
	process.stderr.write(`Fatal error: ${error}\n`);
	process.exit(1);
});
