/**
 * ADR-0024 出站请求守卫 —— 回归套件
 *
 * 锁定安全审查 H2 的修复：管理员填写的「OpenAI 兼容服务地址」会被服务端直接 fetch
 * 并带上平台密钥，因此必须：
 *   1. 恒定拒绝非法协议 / 内嵌凭据 / 云元数据地址；
 *   2. 默认拒绝回环、私网、链路本地与明文 http（`OUTBOUND_ALLOW_PRIVATE_HOSTS=true` 才放开，
 *      且元数据仍拒绝）；
 *   3. 掩码密钥回落**只在目标主机与已保存主机一致时**发生（否则等于把密钥送往新地址）；
 *   4. 保存时 + 使用点双重校验（老配置可能是在校验上线前写进库的）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from '../server/app.js';
import { assertSafeOutboundUrl } from '../server/lib/outbound-url.js';
import { resolveOpenAiEndpoint } from '../server/services/ai.service.js';

let server: http.Server;
let base = '';
let adminCookie = '';

const origFetch = globalThis.fetch;

async function waitSeeds(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/db/status`);
      const body = (await res.json()) as any;
      if (body.userCount >= 3) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('seed users not ready');
}

const MINI_CONFIG = {
  openai_base_url: 'http://127.0.0.1:9/v1',
  openai_api_key: 'sk-test',
} as any;

/**
 * 守卫的判据是 `code`（`OUTBOUND_URL_REJECTED`）而不是 message 文本——
 * message 面向运维，措辞会改；code 是对外契约，不能改。
 */
function assertRejected(fn: () => unknown, messagePattern: RegExp, label: string): void {
  assert.throws(
    fn,
    (err: any) => {
      assert.equal(err?.code, 'OUTBOUND_URL_REJECTED', `${label}：错误码应为 OUTBOUND_URL_REJECTED`);
      assert.match(String(err?.message || ''), messagePattern, `${label}：message 应说明原因`);
      return true;
    },
    label
  );
}

describe('ADR-0024 出站守卫', () => {
  describe('单元：恒定拒绝', () => {
    test('非法协议与相对路径', () => {
      for (const bad of ['file:///etc/passwd', 'gopher://x/1', 'javascript:alert(1)', '/v1', 'not a url']) {
        assertRejected(() => assertSafeOutboundUrl(bad, { purpose: 't' }), /不支持的协议|合法的绝对 URL/, bad);
      }
    });

    test('URL 内嵌凭据', () => {
      assertRejected(
        () => assertSafeOutboundUrl('https://user:pw@api.openai.com/v1', { purpose: 't' }),
        /不得内嵌用户名或口令/,
        'userinfo'
      );
    });

    test('云元数据地址：即使放开内网也必须拒绝', () => {
      const prev = process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS;
      try {
        process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS = 'true';
        for (const bad of [
          'http://169.254.169.254/latest/meta-data',
          'http://100.100.100.200/latest/meta-data',
          'https://metadata.google.internal/computeMetadata/v1',
        ]) {
          assertRejected(() => assertSafeOutboundUrl(bad, { purpose: 't' }), /云元数据/, bad);
        }
      } finally {
        if (prev === undefined) delete process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS;
        else process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS = prev;
      }
    });
  });

  describe('单元：默认形态（内网与明文拒绝）', () => {
    test('回环 / 私网 / 链路本地 / IPv6 一律拒绝', () => {
      const bad = [
        'http://127.0.0.1:9/v1',
        'http://localhost:11434/v1',
        'http://192.168.1.10/v1',
        'http://10.0.0.5/v1',
        'http://172.16.3.4/v1',
        'http://[::1]:3000/v1',
        'http://169.254.1.1/v1',
      ];
      for (const target of bad) {
        assertRejected(() => assertSafeOutboundUrl(target, { purpose: 't' }), /回环\/内网地址/, target);
      }
    });

    test('公网明文 http 拒绝（密钥不得走明文链路）', () => {
      assertRejected(
        () => assertSafeOutboundUrl('http://api.openai.com/v1', { purpose: 't' }),
        /必须使用 https/,
        'public http'
      );
    });

    test('公网 https 通过（真实 provider 形态）', () => {
      for (const good of [
        'https://api.openai.com/v1',
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'https://api.deepseek.com',
      ]) {
        assert.doesNotThrow(() => assertSafeOutboundUrl(good, { purpose: 't' }), `应放行 ${good}`);
      }
    });

    test('显式开关：放开内网与明文（自托管模型路径）', () => {
      const prev = process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS;
      try {
        process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS = 'true';
        assert.doesNotThrow(() =>
          assertSafeOutboundUrl('http://localhost:11434/v1', { purpose: 't' })
        );
        assert.doesNotThrow(() => assertSafeOutboundUrl('http://10.0.0.5/v1', { purpose: 't' }));
      } finally {
        if (prev === undefined) delete process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS;
        else process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS = prev;
      }
    });
  });

  describe('单元：使用点校验（chat / 自动标题共用）', () => {
    test('库里存着非法地址时，resolveOpenAiEndpoint 直接抛错而不是去请求它', () => {
      assertRejected(
        () => resolveOpenAiEndpoint(MINI_CONFIG, '/responses'),
        /回环\/内网地址/,
        'use-site guard'
      );
      // 合法地址正常拼接
      const ok = resolveOpenAiEndpoint(
        { ...MINI_CONFIG, openai_base_url: 'https://api.openai.com/v1' } as any,
        '/responses'
      );
      assert.equal(ok, 'https://api.openai.com/v1/responses');
    });
  });

  describe('端点：保存与联调', () => {
    before(async () => {
      const app = createApp();
      server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      base = `http://127.0.0.1:${port}`;
      await waitSeeds();

      const res = await fetch(`${base}/api/auth/sign-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@deepdive.ai', password: 'Admin123456!' }),
      });
      adminCookie = (res.headers.get('set-cookie') || '').split(';')[0];
    });
    after(() => {
      globalThis.fetch = origFetch;
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const saveConfig = (patch: Record<string, unknown>) =>
      fetch(`${base}/api/admin/model-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({
          provider: 'openai',
          openai_model: 'test-model',
          openai_api_key: 'sk-test-key',
          ...patch,
        }),
      });

    test('保存非法地址 → 400，且不落库（下次读到的仍是旧值）', async () => {
      const good = await saveConfig({ openai_base_url: 'https://api.openai.com/v1' });
      assert.equal(good.status, 200);

      for (const bad of ['http://127.0.0.1:9/v1', 'file:///etc/passwd', 'http://169.254.169.254/v1']) {
        const res = await saveConfig({ openai_base_url: bad });
        assert.equal(res.status, 400, `保存 ${bad} 应 400`);
        const body = (await res.json()) as any;
        assert.equal(body.code, 'OUTBOUND_URL_REJECTED');
      }

      const got = (await (
        await fetch(`${base}/api/admin/model-config`, { headers: { cookie: adminCookie } })
      ).json()) as any;
      assert.equal(
        got.config.openai_base_url,
        'https://api.openai.com/v1',
        '非法地址不得落库（否则它会成为 chat 的持久化外呼目标）'
      );
    });

    test('联调：换地址但沿用已保存密钥 → 400（密钥不得被送往请求指定的新主机）', async () => {
      await saveConfig({ openai_base_url: 'https://api.openai.com/v1' });

      const res = await fetch(`${base}/api/admin/model-config/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({
          provider: 'openai',
          openai_base_url: 'https://evil.example/v1',
          openai_model: 'test-model',
          // 刻意不带 api key：旧实现会在此回落到已保存的真实密钥并发往 evil.example
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.code, 'API_KEY_REQUIRED_FOR_NEW_HOST');
    });

    test('联调：同地址沿用已保存密钥仍可用（便利性未被一刀切掉）', async () => {
      await saveConfig({ openai_base_url: 'https://api.openai.com/v1' });

      // fetch 分发器（既有约定）：只拦上游 provider，其余透传——否则本测试**自己**打给
      // 本服务的请求也会被 stub 吃掉（这正是踩过的坑）。
      let hitUrls: string[] = [];
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(typeof input === 'string' ? input : input?.url || '');
        if (url.startsWith('https://api.openai.com')) {
          hitUrls.push(url);
          return new Response(
            JSON.stringify({ choices: [{ message: { content: 'Arborize OpenAI Integration OK!' } }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return origFetch(input, init);
      }) as typeof fetch;

      const res = await fetch(`${base}/api/admin/model-config/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ provider: 'openai', openai_model: 'test-model' }),
      });
      globalThis.fetch = origFetch;

      assert.equal(res.status, 200);
      assert.deepEqual(hitUrls, ['https://api.openai.com/v1/chat/completions']);
    });

    test('联调：非法地址在守卫处就被拦下，不会发出任何外呼', async () => {
      let outboundCalls = 0;
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(typeof input === 'string' ? input : input?.url || '');
        if (!url.startsWith(base)) outboundCalls += 1;
        return origFetch(input, init);
      }) as typeof fetch;

      const res = await fetch(`${base}/api/admin/model-config/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({
          provider: 'openai',
          openai_base_url: 'http://169.254.169.254/v1',
          openai_model: 'test-model',
          openai_api_key: 'sk-explicit',
        }),
      });
      globalThis.fetch = origFetch;

      assert.equal(res.status, 400);
      assert.equal((await res.json() as any).code, 'OUTBOUND_URL_REJECTED');
      assert.equal(outboundCalls, 0, '守卫必须先于 fetch 生效——零外呼');
    });
  });
});
