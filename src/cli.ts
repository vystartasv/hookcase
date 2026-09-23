import { readFile } from "node:fs/promises";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADERS = 16;
const MAX_HEADER_NAME = 64;
const MAX_HEADER_VALUE = 256;
const MAX_EVENT_ID = 64;
const MAX_EVENT_TYPE = 64;
const MAX_PATH = 512;
const MAX_NESTING = 8;
const MIN_TIMESTAMP = 946684800;
const MAX_TIMESTAMP = 4102444800;
const JSON_CONTENT_TYPE = "application/json";
const SECRET_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const EVENT_TYPE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]{0,511}$/;
const HEADER_NAME_RE = /^x-[a-z0-9-]{1,63}$/;
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "set-cookie",
  "transfer-encoding",
  "x-hookcase-signature",
  "x-hookcase-timestamp",
]);

export type JsonObject = Record<string, unknown>;

export interface EventInput {
  id: string;
  type: string;
  method: "POST";
  path: string;
  timestamp: number;
  body: unknown;
  headers?: Record<string, string>;
  contentType?: "application/json";
}

export interface Fixture {
  version: 1;
  eventId: string;
  eventType: string;
  method: "POST";
  path: string;
  body: string;
  contentType: "application/json";
  headers: Record<string, string>;
  timestamp: number;
  signature: string;
  secret: { source: "environment"; name: string; stored: false };
}

export class CliError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

class JsonSyntaxError extends Error {}

class JsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.value();
    this.whitespace();
    if (this.index !== this.source.length) throw new JsonSyntaxError("trailing data");
    return value;
  }

  private value(): unknown {
    this.whitespace();
    const char = this.source[this.index];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    if (char === "t" && this.take("true")) return true;
    if (char === "f" && this.take("false")) return false;
    if (char === "n" && this.take("null")) return null;
    const number = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      this.index += number[0].length;
      const parsed = Number(number[0]);
      if (!Number.isFinite(parsed)) throw new JsonSyntaxError("non-finite number");
      return parsed;
    }
    throw new JsonSyntaxError("value expected");
  }

  private object(): JsonObject {
    this.expect("{");
    const object: JsonObject = {};
    const keys = new Set<string>();
    this.whitespace();
    if (this.take("}")) return object;
    while (true) {
      this.whitespace();
      if (this.source[this.index] !== '"') throw new JsonSyntaxError("object key expected");
      const key = this.string();
      if (keys.has(key)) throw new JsonSyntaxError(`duplicate key ${key}`);
      keys.add(key);
      this.whitespace();
      this.expect(":");
      object[key] = this.value();
      this.whitespace();
      if (this.take("}")) return object;
      this.expect(",");
    }
  }

  private array(): unknown[] {
    this.expect("[");
    const array: unknown[] = [];
    this.whitespace();
    if (this.take("]")) return array;
    while (true) {
      array.push(this.value());
      this.whitespace();
      if (this.take("]")) return array;
      this.expect(",");
    }
  }

  private string(): string {
    const start = this.index;
    this.expect('"');
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (char === '"') {
        try {
          return JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          throw new JsonSyntaxError("invalid string");
        }
      }
      if (char === "\\") {
        if (this.index >= this.source.length) throw new JsonSyntaxError("invalid escape");
        if (this.source[this.index++] === "u") this.index += 4;
      } else if (char < " ") {
        throw new JsonSyntaxError("control character in string");
      }
    }
    throw new JsonSyntaxError("unterminated string");
  }

  private whitespace(): void {
    while (/[\t\n\r ]/.test(this.source[this.index] ?? "")) this.index++;
  }

  private expect(value: string): void {
    if (!this.take(value)) throw new JsonSyntaxError(`expected ${value}`);
  }

  private take(value: string): boolean {
    if (this.source.startsWith(value, this.index)) {
      this.index += value.length;
      return true;
    }
    return false;
  }
}

export function parseJson(text: string): unknown {
  try {
    return new JsonParser(text).parse();
  } catch {
    throw new CliError("malformed JSON", 2);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectObject(value: unknown, message: string): JsonObject {
  if (!isObject(value)) throw new CliError(message, 3);
  return value;
}

function expectString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new CliError(message, 3);
  return value;
}

function expectInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CliError(message, 3);
  return value;
}

function assertKeys(object: JsonObject, allowed: readonly string[], message: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedSet.has(key))) throw new CliError(message, 3);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateDepth(value: unknown, depth = 0): void {
  if (depth > MAX_NESTING) throw new CliError(`body nesting exceeds ${MAX_NESTING}`, 3);
  if (Array.isArray(value)) {
    for (const item of value) validateDepth(item, depth + 1);
  } else if (isObject(value)) {
    for (const item of Object.values(value)) validateDepth(item, depth + 1);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CliError("body contains a non-finite number", 3);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new CliError("body contains an unsupported JSON value", 3);
}

function validateBody(value: unknown): string {
  if (!isObject(value) && !Array.isArray(value)) throw new CliError("body must be a JSON object or array", 3);
  validateDepth(value);
  const body = canonicalJson(value);
  if (byteLength(body) > MAX_BODY_BYTES) throw new CliError(`body exceeds ${MAX_BODY_BYTES} bytes`, 3);
  return body;
}

function validateHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const object = expectObject(value, "headers must be an object");
  if (Object.keys(object).length > MAX_HEADERS - 3) throw new CliError(`at most ${MAX_HEADERS - 3} selected headers are allowed`, 3);
  const result: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(object)) {
    const lowerName = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lowerName)) throw new CliError(`forbidden header: ${lowerName}`, 3);
    if (!HEADER_NAME_RE.test(name)) throw new CliError(`unsupported header name: ${name}`, 3);
    if (Object.hasOwn(result, lowerName)) throw new CliError(`duplicate header: ${lowerName}`, 3);
    const headerValue = expectString(rawValue, `header value must be a string: ${name}`);
    if (headerValue.includes("\r") || headerValue.includes("\n")) throw new CliError(`header injection: ${name}`, 3);
    if (byteLength(headerValue) > MAX_HEADER_VALUE) throw new CliError(`header value exceeds ${MAX_HEADER_VALUE} bytes: ${name}`, 3);
    result[lowerName] = headerValue;
  }
  return result;
}

function validateEvent(value: unknown): EventInput {
  const object = expectObject(value, "event must be an object");
  assertKeys(object, ["id", "type", "method", "path", "timestamp", "body", "headers", "contentType"], "event contains unsupported fields");
  const id = expectString(object.id, "event id must be a string");
  if (id.length > MAX_EVENT_ID || !EVENT_ID_RE.test(id)) throw new CliError("invalid event id", 3);
  const type = expectString(object.type, "event type must be a string");
  if (type.length > MAX_EVENT_TYPE || !EVENT_TYPE_RE.test(type)) throw new CliError("invalid event type", 3);
  if (object.method !== "POST") throw new CliError("only POST is supported", 3);
  const path = expectString(object.path, "path must be a string");
  if (path.length > MAX_PATH || !PATH_RE.test(path)) throw new CliError("invalid path", 3);
  const timestamp = expectInteger(object.timestamp, "timestamp must be an integer");
  if (timestamp < MIN_TIMESTAMP || timestamp > MAX_TIMESTAMP) throw new CliError("timestamp is out of bounds", 3);
  if (object.contentType !== undefined && object.contentType !== JSON_CONTENT_TYPE) throw new CliError("only application/json is supported", 3);
  const headers = validateHeaders(object.headers);
  return { id, type, method: "POST", path, timestamp, body: object.body, headers, contentType: JSON_CONTENT_TYPE };
}

function validateSecretName(name: string): void {
  if (!SECRET_ENV_RE.test(name)) throw new CliError("invalid secret environment variable name", 2);
}

function readSecret(name: string): string {
  validateSecretName(name);
  const secret = process.env[name];
  if (!secret) throw new CliError(`secret environment variable is missing or empty: ${name}`, 4);
  if (byteLength(secret) > 256) throw new CliError("secret exceeds 256 bytes", 4);
  return secret;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sortedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)));
}

export async function createFixture(eventValue: unknown, secretEnvName: string): Promise<Fixture> {
  const event = validateEvent(eventValue);
  const secret = readSecret(secretEnvName);
  const body = validateBody(event.body);
  const timestamp = String(event.timestamp);
  const signature = `sha256=${await hmacHex(secret, `${timestamp}.${body}`)}`;
  return {
    version: 1,
    eventId: event.id,
    eventType: event.type,
    method: event.method,
    path: event.path,
    body,
    contentType: JSON_CONTENT_TYPE,
    headers: sortedHeaders({ ...event.headers, "content-type": JSON_CONTENT_TYPE, "x-hookcase-signature": signature, "x-hookcase-timestamp": timestamp }),
    timestamp: event.timestamp,
    signature,
    secret: { source: "environment", name: secretEnvName, stored: false },
  };
}

function validateHeaderMap(headersValue: unknown): Record<string, string> {
  const headers = expectObject(headersValue, "fixture headers must be an object");
  if (Object.keys(headers).length > MAX_HEADERS) throw new CliError(`at most ${MAX_HEADERS} headers are allowed`, 3);
  const result: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lowerName) && !["content-type", "x-hookcase-signature", "x-hookcase-timestamp"].includes(lowerName)) throw new CliError(`forbidden header: ${lowerName}`, 3);
    if (lowerName !== "content-type" && lowerName !== "x-hookcase-signature" && lowerName !== "x-hookcase-timestamp" && !HEADER_NAME_RE.test(name)) {
      throw new CliError(`unsupported header name: ${name}`, 3);
    }
    if (Object.hasOwn(result, lowerName)) throw new CliError(`duplicate header: ${lowerName}`, 3);
    const headerValue = expectString(rawValue, `header value must be a string: ${name}`);
    if (headerValue.includes("\r") || headerValue.includes("\n")) throw new CliError(`header injection: ${name}`, 3);
    if (byteLength(headerValue) > MAX_HEADER_VALUE) throw new CliError(`header value exceeds ${MAX_HEADER_VALUE} bytes: ${name}`, 3);
    result[lowerName] = headerValue;
  }
  return result;
}

export function validateFixtureShape(value: unknown): Fixture {
  const object = expectObject(value, "fixture must be an object");
  assertKeys(object, ["version", "eventId", "eventType", "method", "path", "body", "contentType", "headers", "timestamp", "signature", "secret"], "fixture contains unsupported fields");
  if (object.version !== 1) throw new CliError("unsupported fixture version", 3);
  const eventId = expectString(object.eventId, "fixture eventId must be a string");
  if (!EVENT_ID_RE.test(eventId)) throw new CliError("invalid fixture eventId", 3);
  const eventType = expectString(object.eventType, "fixture eventType must be a string");
  if (!EVENT_TYPE_RE.test(eventType)) throw new CliError("invalid fixture eventType", 3);
  if (object.method !== "POST") throw new CliError("only POST is supported", 3);
  const path = expectString(object.path, "fixture path must be a string");
  if (!PATH_RE.test(path)) throw new CliError("invalid fixture path", 3);
  if (object.contentType !== JSON_CONTENT_TYPE) throw new CliError("fixture contentType must be application/json", 3);
  const body = expectString(object.body, "fixture body must be a string");
  if (byteLength(body) > MAX_BODY_BYTES) throw new CliError(`body exceeds ${MAX_BODY_BYTES} bytes`, 3);
  const parsedBody = parseJson(body);
  if (!isObject(parsedBody) && !Array.isArray(parsedBody)) throw new CliError("fixture body must be a JSON object or array", 3);
  validateDepth(parsedBody);
  if (canonicalJson(parsedBody) !== body) throw new CliError("fixture body is not canonical JSON", 3);
  const timestamp = expectInteger(object.timestamp, "fixture timestamp must be an integer");
  if (timestamp < MIN_TIMESTAMP || timestamp > MAX_TIMESTAMP) throw new CliError("timestamp is out of bounds", 3);
  const signature = expectString(object.signature, "fixture signature must be a string");
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) throw new CliError("invalid fixture signature", 3);
  const secretObject = expectObject(object.secret, "fixture secret metadata must be an object");
  assertKeys(secretObject, ["source", "name", "stored"], "fixture secret metadata contains unsupported fields");
  if (secretObject.source !== "environment" || secretObject.stored !== false) throw new CliError("invalid fixture secret metadata", 3);
  const secretName = expectString(secretObject.name, "fixture secret name must be a string");
  validateSecretName(secretName);
  const headers = validateHeaderMap(object.headers);
  const expectedHeaders = new Set(["content-type", "x-hookcase-signature", "x-hookcase-timestamp"]);
  for (const name of Object.keys(headers)) {
    if (name.startsWith("x-hookcase-") && !expectedHeaders.has(name)) throw new CliError(`unsupported generated header: ${name}`, 3);
  }
  if (headers["content-type"] !== JSON_CONTENT_TYPE) throw new CliError("fixture content-type header mismatch", 3);
  if (headers["x-hookcase-timestamp"] !== String(timestamp)) throw new CliError("fixture timestamp header mismatch", 3);
  if (headers["x-hookcase-signature"] !== signature) throw new CliError("fixture signature header mismatch", 3);
  return { version: 1, eventId, eventType, method: "POST", path, body, contentType: JSON_CONTENT_TYPE, headers: sortedHeaders(headers), timestamp, signature, secret: { source: "environment", name: secretName, stored: false } };
}

export async function checkFixture(value: unknown): Promise<Fixture> {
  const fixture = validateFixtureShape(value);
  const secret = readSecret(fixture.secret.name);
  const expected = `sha256=${await hmacHex(secret, `${fixture.timestamp}.${fixture.body}`)}`;
  if (expected !== fixture.signature) throw new CliError("invalid signature", 3);
  return fixture;
}

async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError(`cannot read ${path}`, 2);
  }
  return parseJson(text);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function usage(): never {
  throw new CliError("usage: hookcase create EVENT.json --secret-env NAME --out FIXTURE.json | check FIXTURE.json | diff OLD.json NEW.json | demo", 2);
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new CliError(`missing ${name}`, 2);
  return args[index + 1];
}

function ensureNoUnknownOptions(args: string[], allowed: string[]): void {
  for (const arg of args) if (arg.startsWith("--") && !allowed.includes(arg)) throw new CliError(`unknown option: ${arg}`, 2);
}

function summary(fixture: Fixture, bodySha256: string): unknown {
  return { eventId: fixture.eventId, eventType: fixture.eventType, request: { method: fixture.method, path: fixture.path, body: fixture.body, bodySha256, headers: fixture.headers } };
}

const DEMO_EVENT: EventInput = {
  id: "evt_demo_001",
  type: "order.created",
  method: "POST",
  path: "/webhooks/orders",
  timestamp: 1700000000,
  body: { amount: 1250, orderId: "ord_42", status: "paid" },
  headers: { "x-fixture-source": "hookcase-demo" },
};

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const command = args[0];
    if (!command) usage();
    if (command === "create") {
      if (!args[1]) usage();
      ensureNoUnknownOptions(args.slice(2), ["--secret-env", "--out"]);
      const secretEnv = option(args.slice(2), "--secret-env");
      const out = option(args.slice(2), "--out");
      const event = await readJsonFile(args[1]);
      const fixture = await createFixture(event, secretEnv);
      await Bun.write(out, json(fixture));
      console.log(`created ${out}`);
      return 0;
    }
    if (command === "check") {
      if (args.length !== 2) usage();
      const fixture = await checkFixture(await readJsonFile(args[1]));
      console.log(`valid ${fixture.eventId}`);
      return 0;
    }
    if (command === "diff") {
      if (args.length !== 3) usage();
      const oldFixture = validateFixtureShape(await readJsonFile(args[1]));
      const newFixture = validateFixtureShape(await readJsonFile(args[2]));
      const fields = ["version", "eventId", "eventType", "method", "path", "contentType", "timestamp", "signature", "secret.name"];
      const oldValues: Record<string, unknown> = { ...oldFixture, "secret.name": oldFixture.secret.name };
      const newValues: Record<string, unknown> = { ...newFixture, "secret.name": newFixture.secret.name };
      const changed = fields.filter((field) => oldValues[field] !== newValues[field]).map((field) => ({ field, old: oldValues[field], new: newValues[field] }));
      const headerNames = new Set([...Object.keys(oldFixture.headers), ...Object.keys(newFixture.headers)]);
      for (const name of [...headerNames].sort()) {
        if (oldFixture.headers[name] !== newFixture.headers[name]) changed.push({ field: `headers.${name}`, old: oldFixture.headers[name] ?? null, new: newFixture.headers[name] ?? null });
      }
      changed.sort((left, right) => String(left.field).localeCompare(String(right.field)));
      const oldBodySha256 = await sha256Hex(oldFixture.body);
      const newBodySha256 = await sha256Hex(newFixture.body);
      const result = { changed, body: { same: oldBodySha256 === newBodySha256, oldSha256: oldBodySha256, newSha256: newBodySha256 } };
      console.log(json(result).trimEnd());
      return changed.length || !result.body.same ? 1 : 0;
    }
    if (command === "demo") {
      if (args.length !== 1) usage();
      const fixture = await createFixture(DEMO_EVENT, "HOOKCASE_DEMO_SECRET");
      console.log(json(await summary(fixture, await sha256Hex(fixture.body))).trimEnd());
      return 0;
    }
    usage();
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`hookcase: ${error.message}`);
      return error.exitCode;
    }
    console.error("hookcase: unexpected error");
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
