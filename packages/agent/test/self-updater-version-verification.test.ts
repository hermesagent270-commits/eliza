import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { performUpdate } from "../src/services/self-updater.ts";

const originalPath = process.env.PATH;
let directory: string | undefined;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function writeExecutable(name: string, unixBody: string, windowsBody: string) {
  if (!directory) throw new Error("fixture directory is not initialized");
  const bin = path.join(directory, "bin");
  const executable = path.join(
    bin,
    `${name}${process.platform === "win32" ? ".cmd" : ""}`,
  );
  writeFileSync(
    executable,
    process.platform === "win32" ? windowsBody : unixBody,
  );
  if (process.platform !== "win32") chmodSync(executable, 0o755);
}

it("rejects an update command that leaves the installed version unchanged", async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "eliza-update-version-"));
  mkdirSync(path.join(directory, "bin"));
  writeExecutable("npm", "#!/bin/sh\nexit 0\n", "@exit /b 0\r\n");
  writeExecutable(
    "eliza",
    "#!/bin/sh\nprintf '%s\\n' 'eliza/1.2.3'\n",
    "@echo eliza/1.2.3\r\n",
  );
  process.env.PATH = `${path.join(directory, "bin")}${path.delimiter}${originalPath ?? ""}`;

  await expect(performUpdate("1.2.3", "stable", "npm-global")).resolves.toEqual(
    {
      success: false,
      method: "npm-global",
      command: "npm install -g elizaos@latest",
      previousVersion: "1.2.3",
      newVersion: "1.2.3",
      error:
        "Update command completed, but the installed version is still 1.2.3.",
    },
  );
});
