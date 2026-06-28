/**
 * StarCoin 中央配置模块
 *
 * 统一从 .env 文件加载配置，提供带默认值的配置对象。
 * 所有模块通过 require('./config') 获取配置，不再使用硬编码常量。
 *
 * 使用方式：
 *   const config = require('./config');
 *   console.log(config.PORT);
 */
const path = require('path');

// dotenv 加载 .env 文件（必须在任何其他模块引用之前）
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// 辅助：解析整数环境变量
function int(val, defaultVal) {
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? defaultVal : parsed;
}

// 辅助：解析浮点环境变量
function float(val, defaultVal) {
    const parsed = parseFloat(val);
    return isNaN(parsed) ? defaultVal : parsed;
}

// 辅助：解析布尔环境变量
function bool(val, defaultVal) {
    if (val === undefined || val === null) return defaultVal;
    if (typeof val === 'boolean') return val;
    if (val === 'true' || val === '1') return true;
    if (val === 'false' || val === '0') return false;
    return defaultVal;
}

const config = {
    // ======== 节点配置 ========
    /** HTTP/WS 服务端口 */
    PORT: int(process.env.PORT, 3000),
    /** 种子节点列表（逗号分隔的 WebSocket URL） */
    SEED_PEERS: (process.env.SEED_PEERS || '').split(',').map(s => s.trim()).filter(Boolean),
    /** 自定义节点名称（可选） */
    NODE_NAME: process.env.NODE_NAME || '',

    // ======== P2P 重连配置 ========
    /** 重连初始延迟（毫秒） */
    P2P_RECONNECT_BASE_DELAY: int(process.env.P2P_RECONNECT_BASE_DELAY, 1000),
    /** 重连最大延迟（毫秒） */
    P2P_RECONNECT_MAX_DELAY: int(process.env.P2P_RECONNECT_MAX_DELAY, 30000),
    /** 最大重试次数 */
    P2P_RECONNECT_MAX_RETRIES: int(process.env.P2P_RECONNECT_MAX_RETRIES, 50),
    /** 随机抖动系数（0~1） */
    P2P_RECONNECT_JITTER: float(process.env.P2P_RECONNECT_JITTER, 0.3),

    // ======== P2P 心跳配置 ========
    /** 心跳发送间隔（毫秒） */
    P2P_HEARTBEAT_INTERVAL: int(process.env.P2P_HEARTBEAT_INTERVAL, 15000),
    /** 心跳超时阈值（毫秒） */
    P2P_HEARTBEAT_TIMEOUT: int(process.env.P2P_HEARTBEAT_TIMEOUT, 6000),

    // ======== 节点发现配置 ========
    /** 自动发现请求间隔（毫秒） */
    P2P_DISCOVERY_INTERVAL: int(process.env.P2P_DISCOVERY_INTERVAL, 30000),
    /** 最大对等节点数 */
    P2P_DISCOVERY_MAX_PEERS: int(process.env.P2P_DISCOVERY_MAX_PEERS, 20),
    /** 每轮最大尝试连接数 */
    P2P_DISCOVERY_MAX_PER_ROUND: int(process.env.P2P_DISCOVERY_MAX_PER_ROUND, 3),

    // ======== 链同步配置 ========
    /** 同步响应超时（毫秒） */
    SYNC_TIMEOUT: int(process.env.SYNC_TIMEOUT, 10000),
    /** 定期自动同步间隔（毫秒） */
    SYNC_INTERVAL: int(process.env.SYNC_INTERVAL, 60000),
    /** 链健康检查间隔（毫秒） */
    SYNC_HEALTH_CHECK_INTERVAL: int(process.env.SYNC_HEALTH_CHECK_INTERVAL, 30000),
    /** 启动后首次连接延迟（毫秒） */
    SYNC_STARTUP_CONNECT_DELAY: int(process.env.SYNC_STARTUP_CONNECT_DELAY, 1500),

    // ======== 挖矿/区块配置 ========
    /** 矿工奖励金额 */
    MINING_REWARD: float(process.env.MINING_REWARD, 50),
    /** 矿工奖励锁定期（区块数） */
    MINING_COINBASE_MATURITY: int(process.env.MINING_COINBASE_MATURITY, 5),
    /** 每区块最大打包交易数 */
    MINING_MAX_TXS_PER_BLOCK: int(process.env.MINING_MAX_TXS_PER_BLOCK, 100),

    // ======== 难度调整配置 ========
    /** 初始难度 */
    DIFFICULTY_INITIAL: float(process.env.DIFFICULTY_INITIAL, 5),
    /** 目标出块时间（秒） */
    DIFFICULTY_TARGET_TIME: int(process.env.DIFFICULTY_TARGET_TIME, 12),
    /** 每 N 个区块调整一次 */
    DIFFICULTY_ADJUST_INTERVAL: int(process.env.DIFFICULTY_ADJUST_INTERVAL, 6),
    /** 最小难度 */
    DIFFICULTY_MIN: float(process.env.DIFFICULTY_MIN, 3),
    /** 最大难度 */
    DIFFICULTY_MAX: float(process.env.DIFFICULTY_MAX, 12),
    /** 调整步长 */
    DIFFICULTY_STEP: float(process.env.DIFFICULTY_STEP, 0.1),

    // ======== API 限流配置 ========
    /** 全局读接口：时间窗口（毫秒） */
    RATE_LIMIT_GLOBAL_WINDOW_MS: int(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS, 60 * 1000),
    /** 全局读接口：允许请求数 / 窗口 */
    RATE_LIMIT_GLOBAL_MAX: int(process.env.RATE_LIMIT_GLOBAL_MAX, 60),
    /** 写操作敏感路由：时间窗口（毫秒） */
    RATE_LIMIT_WRITE_WINDOW_MS: int(process.env.RATE_LIMIT_WRITE_WINDOW_MS, 60 * 1000),
    /** 写操作敏感路由：允许请求数 / 窗口 */
    RATE_LIMIT_WRITE_MAX: int(process.env.RATE_LIMIT_WRITE_MAX, 10),
    /** 搜索 / 重查询路由：时间窗口（毫秒） */
    RATE_LIMIT_SEARCH_WINDOW_MS: int(process.env.RATE_LIMIT_SEARCH_WINDOW_MS, 60 * 1000),
    /** 搜索 / 重查询路由：允许请求数 / 窗口 */
    RATE_LIMIT_SEARCH_MAX: int(process.env.RATE_LIMIT_SEARCH_MAX, 20),
};

module.exports = config;