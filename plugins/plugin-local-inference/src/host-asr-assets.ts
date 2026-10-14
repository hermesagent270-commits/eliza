/**
 * Which pinned ASR model the host ASR worker verifies and loads.
 *
 * `<root>/asr/` holds one backend of libelizainference's ASR surface:
 *   - parakeet: `asr/phonon-2-fv5.gguf`, Phonon-2 (Parakeet-TDT 0.6B,
 *     five-value weights; FermionResearch/Phonon-2, CC-BY-4.0). The default
 *     whenever the file is present.
 *   - qwen3: the Qwen3-ASR-0.6B Q8_0 text GGUF + audio mmproj.
 * `ELIZA_ASR_BACKEND` (`parakeet`, or `qwen3`/`mtmd`) forces one, the same
 * variable the library reads in `mmap_acquire("asr")`. The selected files must
 * be the only GGUFs under `asr/`, so the library can load nothing but the
 * bytes the worker hashed: it picks a parakeet-tdt GGUF first, and its Qwen3
 * picker needs exactly one text GGUF beside the mmproj.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PinnedSpeechAsset } from "./host-speech-runtime";

export type HostAsrBackend = "parakeet" | "qwen3";

/**
 * Phonon-2 converted by elizaOS/llama.cpp tools/parakeet/convert_phonon2_to_gguf.py
 * from FermionResearch/Phonon-2@7e153e4054c0a10db6d47d6fff5c062d4c77c154
 * (byte-reproducible; the same pin as the `mobile-voice` catalog row
 * `phonon-2-fv5`).
 */
export const PHONON_ASR_ASSETS: readonly PinnedSpeechAsset[] = [
	{
		path: "asr/phonon-2-fv5.gguf",
		sha256: "dc552eb786486167dde3ac80bbe49a6088c8ef39c03c257d5a090fc57b2c47b3",
		bytes: 330_632_256,
	},
];

/**
 * Qwen3-ASR-0.6B Q8_0 text GGUF + audio mmproj, the pair the fused Qwen3 ASR
 * path loads from `<bundle>/asr/`.
 * TODO: read these from the voice model registry record once it carries the
 * Qwen3-ASR pair, so the pins live in one place.
 */
export const QWEN3_ASR_ASSETS: readonly PinnedSpeechAsset[] = [
	{
		path: "asr/eliza-1-asr.gguf",
		sha256: "bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971",
		bytes: 804_749_248,
	},
	{
		path: "asr/eliza-1-asr-mmproj.gguf",
		sha256: "41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d",
		bytes: 214_392_480,
	},
];

export interface HostAsrSelection {
	backend: HostAsrBackend;
	assets: readonly PinnedSpeechAsset[];
}

/**
 * Pick the backend for `root` (see the module comment) and check that `asr/`
 * holds no other GGUF. Throws a fixed message on a forced backend whose files
 * are missing or on extra GGUFs. Hashing is the caller's job.
 */
export function selectHostAsrAssets(
	root: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): HostAsrSelection {
	const forced = env.ELIZA_ASR_BACKEND?.trim().toLowerCase() ?? "";
	let backend: HostAsrBackend;
	if (forced === "qwen3" || forced === "mtmd") backend = "qwen3";
	else if (forced === "parakeet") backend = "parakeet";
	else if (forced === "" || forced === "auto")
		backend = existsSync(join(root, PHONON_ASR_ASSETS[0]?.path ?? ""))
			? "parakeet"
			: "qwen3";
	else throw Error("Invalid speech ASR backend");
	const assets = backend === "parakeet" ? PHONON_ASR_ASSETS : QWEN3_ASR_ASSETS;
	const expected = assets.map((asset) => asset.path.slice("asr/".length));
	const present = readdirSync(join(root, "asr"), {
		recursive: true,
		encoding: "utf8",
	})
		.filter((file) => file.endsWith(".gguf"))
		.sort();
	if (
		present.length !== expected.length ||
		[...expected].sort().some((name, i) => present[i] !== name)
	)
		throw Error("Ambiguous speech ASR model");
	return { backend, assets };
}
