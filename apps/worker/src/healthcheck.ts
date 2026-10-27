// 容器健康检查：node apps/worker/dist/healthcheck.js，最近有心跳时退出码为 0。
import { HEARTBEAT_MAX_AGE_MS, heartbeatAge } from "./heartbeat.js";

const age = await heartbeatAge();
process.exit(age !== null && age < HEARTBEAT_MAX_AGE_MS ? 0 : 1);
