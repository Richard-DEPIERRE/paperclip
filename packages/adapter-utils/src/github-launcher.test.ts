import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";
const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("managed GitHub launchers", () => {
  it.each(["repository", "command"])("uses explicit %s identity for local commits without managed credentials", async (identitySource) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-local-identity-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const env = { ...process.env, ...githubBrokerEnvironment({
      GH_TOKEN: "host-token", GIT_AUTHOR_NAME: "Host", GIT_COMMITTER_NAME: "Host",
    }, { url: "", token: "" }), PATH: `${bin}:${process.env.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: root, env })).stdout.trim();
    // No configured identity must fail, rather than guessing the host user's.
    await expect(git("var", "GIT_AUTHOR_IDENT")).rejects.toThrow();
    await expect(git("var", "GIT_COMMITTER_IDENT")).rejects.toThrow();
    if (identitySource === "repository") {
      await git("config", "user.name", "Local Author");
      await git("config", "user.email", "local@example.test");
    }
    await git(...(identitySource === "command" ? ["-c", "user.name=Local Author", "-c", "user.email=local@example.test"] : []),
      "commit", "--allow-empty", "-m", "Local work");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Local Author <local@example.test>|Local Author <local@example.test>");
  });

  it.each(["broker-offline", "config-unwritable", "capability-rejected"])("keeps real local Git usable when %s", async (failure) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-failure-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.name", "Local Author"]);
    await exec("git", ["-C", root, "config", "user.email", "local@example.test"]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    if (failure === "broker-offline") await new Promise<void>(resolve => server.close(() => resolve()));
    else cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const configRoot = path.join(root, "config");
    if (failure === "config-unwritable") await writeFile(configRoot, "not a directory");
    const result = await exec(path.join(bin, "git"), ["status", "--porcelain"], { cwd: root, env: {
      ...process.env, ...githubBrokerEnvironment({ GH_TOKEN: "host-must-not-leak" }, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
    expect(result.stderr).toContain(failure === "broker-offline" ? "broker_transport_unavailable" : failure === "config-unwritable" ? "configuration_directory_unavailable" : "capability_rejected");
    expect(result.stderr).not.toMatch(/host-must-not-leak|private-capability/);
    await exec(path.join(bin, "git"), ["commit", "--allow-empty", "-m", "Offline work"], { cwd: root, env: {
      ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
  }, 15_000); // broker-offline retries the transport twice per command before it falls back

  it("explains unavailable access while allowing local work without credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-diagnostic-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    const server = createServer((_req,res) => {
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({status:"unavailable",reason:"More than one managed GitHub identity matches this run",env:{GH_TOKEN:"must-not-be-used"}}));
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    cleanups.push(() => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())));
    const {port} = server.address() as {port:number};
    const result = await exec(path.join(bin,"gh"), [], {env:{...process.env,...githubBrokerEnvironment({GH_TOKEN:"host-token"},{url:`http://127.0.0.1:${port}`,token:"run-capability"}),PATH:`${bin}:${realBin}:${process.env.PATH}`}});
    expect(JSON.parse(result.stdout)).toEqual({token:null});
    expect(result.stderr).toContain("More than one managed GitHub identity matches this run");
    expect(result.stderr).not.toMatch(/host-token|must-not-be-used|run-capability/);
  });
  // The first broker request fails, the second succeeds: the managed token must still reach gh.
  it.each([
    ["connection drops before the response", (res: import("node:http").ServerResponse) => { res.socket?.destroy(); }],
    ["body read fails mid-response", (res: import("node:http").ServerResponse) => {
      res.writeHead(200, {"content-type":"application/json"}); res.write('{"status":'); setTimeout(() => res.socket?.destroy(), 20);
    }],
  ])("retries when the %s and still uses managed credentials", async (_label, fail) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-retry-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    let requests = 0;
    const server = createServer((_req,res) => {
      requests++;
      if (requests === 1) return fail(res);
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({status:"available",env:{GH_TOKEN:"managed-token"}}));
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const {port} = server.address() as {port:number};
    const result = await exec(path.join(bin,"gh"), [], {env:{...process.env,...githubBrokerEnvironment({GH_TOKEN:"host-token"},{url:`http://127.0.0.1:${port}`,token:"run-capability"}),PATH:`${bin}:${realBin}:${process.env.PATH}`}});
    expect(JSON.parse(result.stdout)).toEqual({token:"managed-token"});
    expect(requests).toBe(2);
    expect(result.stderr).not.toContain("broker_transport_unavailable");
    expect(result.stderr).not.toMatch(/host-token|run-capability/);
  });
  it("captures each command's identity and clears host credentials when the next person has none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-launcher-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real"), repo = path.join(root, "repo");
    for (const dir of [bin, realBin, repo, path.join(bin, "gh-config")]) await mkdir(dir, { recursive: true });
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), `#!/usr/bin/env node
const {execFileSync}=require('node:child_process');
const identity=execFileSync('git',['var','GIT_AUTHOR_IDENT'],{encoding:'utf8'}).trim();
process.stdout.write(JSON.stringify({identity, token:process.env.GH_TOKEN ?? null, global:process.env.GIT_CONFIG_GLOBAL, config:process.env.GH_CONFIG_DIR}));
`, { mode: 0o700 });
    let user: string | null = "A", captures = 0;
    let heldCapture: (() => void) | null = null;
    let releaseCapture: (() => void) | null = null;
    const server = createServer((req, res) => {
      captures++;
      expect(req.headers.authorization).toBe("Bearer run-capability");
      const selected = user;
      res.setHeader("content-type", "application/json");
      const finish = () => res.end(JSON.stringify(selected ? { status: "available", env: {
        GH_TOKEN: `credential-${selected}`, GITHUB_TOKEN: `credential-${selected}`,
        GIT_AUTHOR_NAME: selected, GIT_AUTHOR_EMAIL: `${selected}@example.test`,
        GIT_COMMITTER_NAME: selected, GIT_COMMITTER_EMAIL: `${selected}@example.test`,
      } } : { status: "absent", env: {} }));
      if (heldCapture) { const captured = heldCapture; heldCapture = null; releaseCapture = finish; captured(); }
      else finish();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address() as { port: number };
    const env: NodeJS.ProcessEnv = { ...process.env, ...githubBrokerEnvironment({
      GH_TOKEN: "ambient-host-token", GIT_AUTHOR_NAME: "Host", GIT_AUTHOR_EMAIL: "host@example.test",
    }, { url: `http://127.0.0.1:${address.port}`, token: "run-capability" }), PATH: `${bin}:${realBin}:${process.env.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: repo, env })).stdout.trim();
    await git("init");
    await git("config", "user.name", "Repository Author");
    await git("config", "user.email", "repository@example.test");
    await git("commit", "--allow-empty", "-m", "A");
    user = "B";
    await git("commit", "--allow-empty", "-m", "B");
    user = "A";
    await git("commit", "--allow-empty", "-m", "A again");
    expect(await git("log", "--format=%an <%ae>|%cn <%ce>" )).toBe("A <A@example.test>|A <A@example.test>\nB <B@example.test>|B <B@example.test>\nA <A@example.test>|A <A@example.test>");
    const before = captures;
    const gh = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(gh.identity).toContain("A <A@example.test>");
    expect(gh.token).toBe("credential-A");
    expect(captures - before).toBe(1); // gh's child Git retains the same capture.
    const captured = new Promise<void>(resolve => { heldCapture = resolve; });
    const operationA = exec(path.join(bin, "gh"), [], { cwd: repo, env });
    await captured;
    user = "B";
    const operationB = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    releaseCapture!();
    const completedA = JSON.parse((await operationA).stdout);
    expect(completedA.token).toBe("credential-A");
    expect(operationB.token).toBe("credential-B");
    expect(completedA.config).not.toBe(operationB.config);
    user = null;
    await git("commit", "--allow-empty", "-m", "Local identity");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Repository Author <repository@example.test>|Repository Author <repository@example.test>");
    const anonymous = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(anonymous.token).toBeNull();
    await git("config", "--unset", "user.name");
    await git("config", "--unset", "user.email");
    await expect(git("var", "GIT_AUTHOR_IDENT")).rejects.toThrow();
    expect(await git("status", "--porcelain")).toBe(""); // unrelated public/local Git still works
    expect(env.GH_TOKEN).toBe("");
    expect(env.GIT_AUTHOR_NAME).toBe("");
  });

  // A bare repository planted inside a checkout (an extracted archive) must not run
  // its config or hooks when gh, npm or a plain `git status` discovers it.
  it.each([
    ["no broker", null],
    ["a broker without Git config", { GH_TOKEN: "managed-token" }],
    ["a broker with its own Git config", { GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "url.https://broker.example.test/.insteadOf", GIT_CONFIG_VALUE_1: "broker:" }],
    ["a broker with a non-integer count", { GIT_CONFIG_COUNT: "two", GIT_CONFIG_KEY_0: "url.https://broker.example.test/.insteadOf", GIT_CONFIG_VALUE_0: "broker:" }],
    ["a broker with a negative count", { GIT_CONFIG_COUNT: "-1", GIT_CONFIG_KEY_0: "url.https://broker.example.test/.insteadOf", GIT_CONFIG_VALUE_0: "broker:" }],
    ["a broker with keys but no count", { GIT_CONFIG_KEY_0: "url.https://broker.example.test/.insteadOf", GIT_CONFIG_VALUE_0: "broker:" }],
  ] as const)("only uses bare repositories named explicitly with %s", async (label, brokerEnv) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-bare-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), planted = path.join(root, "workspace", "planted");
    await mkdir(bin);
    await mkdir(planted, { recursive: true });
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    let url = "";
    if (brokerEnv) {
      const server = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "available", env: brokerEnv }));
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
      url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    }
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url, token: url ? "run-capability" : "" }), PATH: `${bin}:${process.env.PATH}` };
    const git = async (cwd: string, ...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd, env })).stdout.trim();
    expect(await git(root, "config", "--show-scope", "--get", "safe.bareRepository")).toBe("command\texplicit");
    const config = await git(root, "config", "--list", "--show-scope");
    if (label === "a broker with its own Git config") {
      expect(config).toContain("command\turl.https://broker.example.test/.insteadof=broker:");
    } else {
      // A malformed broker count is dropped whole; the launcher's own entries stay.
      expect(config).not.toContain("broker.example.test");
      expect(config).toContain("command\tuser.useconfigonly=true");
    }
    await exec("git", ["init", "--bare", "--quiet", planted]);
    await expect(git(planted, "status")).rejects.toThrow(/cannot use bare repository/);
    expect(await git(root, "--git-dir", planted, "rev-parse", "--is-bare-repository")).toBe("true");
  }, 15_000);

  // Git reads -c and --config-env after the GIT_CONFIG_* entries, so an injected "fix"
  // naming safe.bareRepository would load a planted repository's aliases again.
  it.each([
    [["-c", "safe.bareRepository=all"]],
    [["--config-env=safe.barerepository=PAPERCLIP_TEST_BARE"]],
    [["--config-env", "SAFE.bareRepository=PAPERCLIP_TEST_BARE"]],
    [["-C", "workspace/planted", "--no-pager", "-c", " safe.bareRepository=all"]],
    [["--shallow-file", "x", "-c", "safe.bareRepository=all"]],
    [["--shallow-file", "x", "--config-env", "safe.bareRepository=PAPERCLIP_TEST_BARE"]],
  ])("refuses a command-line override of safe.bareRepository: %j", async (options) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-bare-override-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), planted = path.join(root, "workspace", "planted"), marker = path.join(root, "pwned");
    await mkdir(bin);
    await mkdir(planted, { recursive: true });
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    await exec("git", ["init", "--bare", "--quiet", planted]);
    await exec("git", ["--git-dir", planted, "config", "alias.pwn", `!touch ${marker}`]);
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url: "", token: "" }),
      PAPERCLIP_TEST_BARE: "all", PATH: `${bin}:${process.env.PATH}` };
    const cwd = options[0] === "-C" ? root : planted;
    await expect(exec(path.join(bin, "git"), [...options, "pwn"], { cwd, env }))
      .rejects.toThrow(/Paperclip: git -c safe\.bareRepository is refused/);
    await expect(access(marker)).rejects.toThrow();
  });
});
