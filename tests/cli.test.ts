import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkFixture, createFixture, parseJson, validateFixtureShape } from "../src/cli";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;

const event = {
  id: "evt_01",
  type: "order.created",
  method: "POST",
  path: "/webhooks/orders",
  timestamp: 1700000000,
  body: { z: true, orderId: "ord_42", amount: 1250 },
  headers: { "x-source": "test" },
};

function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, cli, ...args],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function withSecret<T>(secret: string, callback: () => Promise<T>): Promise<T> {
  const previous = process.env.TEST_HOOKCASE_SECRET;
  process.env.TEST_HOOKCASE_SECRET = secret;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.TEST_HOOKCASE_SECRET;
    else process.env.TEST_HOOKCASE_SECRET = previous;
  }
}

describe("fixture contract", () => {
  test("creates and checks a happy-path fixture with sorted canonical body", async () => {
    await withSecret("topsecret", async () => {
      const fixture = await createFixture(event, "TEST_HOOKCASE_SECRET");
      expect(fixture.body).toBe('{"amount":1250,"orderId":"ord_42","z":true}');
      expect(fixture.headers).toEqual({
        "content-type": "application/json",
        "x-hookcase-signature": fixture.signature,
        "x-hookcase-timestamp": "1700000000",
        "x-source": "test",
      });
      await expect(checkFixture(fixture)).resolves.toEqual(fixture);
    });
  });

  test("matches the known HMAC vector", async () => {
    await withSecret("key", async () => {
      const fixture = await createFixture({ ...event, body: { a: 1 } }, "TEST_HOOKCASE_SECRET");
      expect(fixture.signature).toBe("sha256=a438e398bfafc57e4396bb7fc2304422f0f768e965d073ca313cb52e22e6ad03");
    });
  });

  test("rejects malformed JSON and duplicate keys", () => {
    expect(() => parseJson("{")).toThrow("malformed JSON");
    expect(() => parseJson('{"headers":{"x-a":"1","x-a":"2"}}')).toThrow("malformed JSON");
  });

  test("rejects bad signature and timestamp bounds", async () => {
    await withSecret("topsecret", async () => {
      const fixture = await createFixture(event, "TEST_HOOKCASE_SECRET");
      await expect(checkFixture({ ...fixture, signature: "sha256=" + "0".repeat(64), headers: { ...fixture.headers, "x-hookcase-signature": "sha256=" + "0".repeat(64) } })).rejects.toThrow("invalid signature");
      await expect(createFixture({ ...event, timestamp: 0 }, "TEST_HOOKCASE_SECRET")).rejects.toThrow("timestamp is out of bounds");
    });
  });

  test("rejects header injection, forbidden headers, and oversized bodies", async () => {
    await withSecret("topsecret", async () => {
      await expect(createFixture({ ...event, headers: { "x-bad": "ok\r\nInjected: yes" } }, "TEST_HOOKCASE_SECRET")).rejects.toThrow("header injection");
      await expect(createFixture({ ...event, headers: { host: "evil" } }, "TEST_HOOKCASE_SECRET")).rejects.toThrow("forbidden header");
      await expect(createFixture({ ...event, body: { data: "x".repeat(65530) } }, "TEST_HOOKCASE_SECRET")).rejects.toThrow("body exceeds");
    });
  });

  test("validates fixture shape without needing the secret", async () => {
    await withSecret("topsecret", async () => {
      const fixture = await createFixture(event, "TEST_HOOKCASE_SECRET");
      expect(validateFixtureShape(fixture).secret.stored).toBe(false);
    });
  });
});

describe("CLI", () => {
  test("diff is deterministic and reports body hashes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hookcase-"));
    try {
      await withSecret("topsecret", async () => {
        const oldFixture = await createFixture(event, "TEST_HOOKCASE_SECRET");
        const newFixture = await createFixture({ ...event, body: { ...event.body, amount: 1300 } }, "TEST_HOOKCASE_SECRET");
        const oldPath = join(directory, "old.json");
        const newPath = join(directory, "new.json");
        await writeFile(oldPath, JSON.stringify(oldFixture));
        await writeFile(newPath, JSON.stringify(newFixture));
        const first = run(["diff", oldPath, newPath]);
        const second = run(["diff", oldPath, newPath]);
        expect(first.status).toBe(1);
        expect(first.stdout).toBe(second.stdout);
        expect(first.stdout).toContain('"oldSha256"');
        expect(first.stdout).toContain('"body"');
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("never persists or prints the secret, and exits stably", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hookcase-"));
    try {
      const eventPath = join(directory, "event.json");
      const fixturePath = join(directory, "fixture.json");
      await writeFile(eventPath, JSON.stringify(event));
      const created = run(["create", eventPath, "--secret-env", "TEST_HOOKCASE_SECRET", "--out", fixturePath], { TEST_HOOKCASE_SECRET: "never-persist-this" });
      expect(created.status).toBe(0);
      expect(created.stdout).not.toContain("never-persist-this");
      expect(await readFile(fixturePath, "utf8")).not.toContain("never-persist-this");
      const checked = run(["check", fixturePath], { TEST_HOOKCASE_SECRET: "never-persist-this" });
      expect(checked.status).toBe(0);
      const bad = run(["check", fixturePath], { TEST_HOOKCASE_SECRET: "wrong" });
      expect(bad.status).toBe(3);
      expect(bad.stderr).toBe("hookcase: invalid signature\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("demo emits a request summary and no curl or secret", () => {
    const result = run(["demo"], { HOOKCASE_DEMO_SECRET: "demo-secret-only-in-test" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"request"');
    expect(result.stdout).toContain('"bodySha256"');
    expect(result.stdout).not.toContain("demo-secret-only-in-test");
    expect(result.stdout).not.toContain("curl");
  });

  test("missing secret uses a distinct exit code", async () => {
    await withSecret("", async () => {
      await expect(createFixture(event, "TEST_HOOKCASE_SECRET")).rejects.toThrow("missing or empty");
    });
    expect(run(["demo"], { HOOKCASE_DEMO_SECRET: "" }).status).toBe(4);
  });
});
