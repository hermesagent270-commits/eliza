import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	PHONON_ASR_ASSETS,
	QWEN3_ASR_ASSETS,
	selectHostAsrAssets,
} from "./host-asr-assets";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function bundle(files: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "host-asr-assets-"));
	roots.push(root);
	mkdirSync(join(root, "asr"), { recursive: true });
	for (const file of files) writeFileSync(join(root, file), "x");
	return root;
}

const phonon = "asr/phonon-2-fv5.gguf";
const qwen = ["asr/eliza-1-asr.gguf", "asr/eliza-1-asr-mmproj.gguf"];

describe("host ASR asset selection", () => {
	it("uses Phonon-2 on the parakeet backend when the bundle has it", () => {
		const selection = selectHostAsrAssets(bundle([phonon]), {});
		expect(selection.backend).toBe("parakeet");
		expect(selection.assets).toBe(PHONON_ASR_ASSETS);
		expect(selection.assets[0]?.sha256).toBe(
			"dc552eb786486167dde3ac80bbe49a6088c8ef39c03c257d5a090fc57b2c47b3",
		);
		expect(selection.assets[0]?.bytes).toBe(330_632_256);
	});

	it("keeps the Qwen3-ASR pair for a bundle without Phonon-2", () => {
		const selection = selectHostAsrAssets(bundle(qwen), {});
		expect(selection.backend).toBe("qwen3");
		expect(selection.assets).toBe(QWEN3_ASR_ASSETS);
		expect(
			selectHostAsrAssets(bundle(qwen), { ELIZA_ASR_BACKEND: "auto" }).backend,
		).toBe("qwen3");
	});

	it("honours ELIZA_ASR_BACKEND like the native library", () => {
		expect(
			selectHostAsrAssets(bundle(qwen), { ELIZA_ASR_BACKEND: "QWEN3" }).backend,
		).toBe("qwen3");
		expect(
			selectHostAsrAssets(bundle(qwen), { ELIZA_ASR_BACKEND: "mtmd" }).backend,
		).toBe("qwen3");
		expect(
			selectHostAsrAssets(bundle([phonon]), { ELIZA_ASR_BACKEND: "parakeet" })
				.backend,
		).toBe("parakeet");
		// A forced backend whose files are absent is refused, never swapped.
		expect(() =>
			selectHostAsrAssets(bundle(qwen), { ELIZA_ASR_BACKEND: "parakeet" }),
		).toThrow("Ambiguous speech ASR model");
		expect(() =>
			selectHostAsrAssets(bundle([phonon]), { ELIZA_ASR_BACKEND: "qwen3" }),
		).toThrow("Ambiguous speech ASR model");
		expect(() =>
			selectHostAsrAssets(bundle([phonon]), { ELIZA_ASR_BACKEND: "whisper" }),
		).toThrow("Invalid speech ASR backend");
	});

	it("refuses an asr/ directory with GGUFs it did not verify", () => {
		// Both backends at once: the library would load parakeet, so the Qwen
		// pair is unverified bytes next to it.
		expect(() => selectHostAsrAssets(bundle([phonon, ...qwen]), {})).toThrow(
			"Ambiguous speech ASR model",
		);
		const root = bundle([phonon]);
		mkdirSync(join(root, "asr", "nested"));
		writeFileSync(join(root, "asr", "nested", "other.gguf"), "x");
		expect(() => selectHostAsrAssets(root, {})).toThrow(
			"Ambiguous speech ASR model",
		);
	});
});
