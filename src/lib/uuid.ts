/**
 * UUIDv7 生成器（路线 A id 统一，2026-09-10）。
 *
 * 选 UUIDv7 而非 v4：48bit 毫秒时间戳前缀保持 B-tree 插入局部性
 * （沿袭旧 `${Date.now()}` id 的时间有序特性），后 74bit 随机防同毫秒碰撞；
 * 恒 36 字符、不可枚举，ADR-0013 的前缀截断防御随之消亡。
 */

/** RFC 9562 UUIDv7：unix_ts_ms(48) + ver(4) + rand(12) + var(2) + rand(62) */
export function uuidv7(): string {
  const ts = Date.now();
  const b = crypto.getRandomValues(new Uint8Array(16));

  // 时间戳 48bit（Date.now 恒为正数，按 8bit 拆填避免 32bit 位运算截断）
  b[0] = Math.floor(ts / 2 ** 40) & 0xff;
  b[1] = Math.floor(ts / 2 ** 32) & 0xff;
  b[2] = (ts >>> 24) & 0xff;
  b[3] = (ts >>> 16) & 0xff;
  b[4] = (ts >>> 8) & 0xff;
  b[5] = ts & 0xff;

  // 版本号 7 + RFC 变体 10
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
