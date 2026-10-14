/**
 * Scans a bundle manifest for ASR lineage/provenance fields that reveal Qwen
 * heritage, returning human-readable blocker strings. Eliza-1 is a Gemma-4
 * release; the strict-release gate rejects any default-eligible bundle whose
 * ASR base or source models still carry Qwen provenance (a pre-cutover
 * stand-in). Paired with `text-provenance.ts`, which reads the same guarantee
 * out of the GGUF header bytes.
 *
 * Scope: this block reads ONLY the Eliza-1 bundle manifest's own ASR lineage
 * (`lineage.asr.base`, `provenance.sourceModels.asr.repo`). The pinned mobile
 * voice bundle (`mobile-voice` in plugin-native-inference's
 * voice-model-versions.json) is not an Eliza-1 manifest: the Android/AOSP
 * agent stages its ASR into `asr/` with an `asr/voice-files.json` record:
 * Phonon-2 (`phonon-2-fv5.gguf`, Parakeet-TDT, not Qwen) by default, or the
 * Qwen3-ASR-0.6B text + mmproj pair with ELIZA_ASR_BACKEND=qwen3. The Eliza-1
 * manifest says nothing about it, so the Qwen-lineage block does not apply to
 * that pair, and a strict Eliza-1 text bundle can transcribe with it on a
 * phone. Gemma-4 audio is too
 * large for phones, and text inference stays on Qwen via Cerebras; this split
 * is an owner decision that still needs explicit owner confirmation.
 */
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
} from "node:fs";
import path from "node:path";
import { claimsStrictRelease } from "./manifest/release-policy";

export const QWEN_PROVENANCE_RE = /\bqwen/i;

function readStringPath(
	input: unknown,
	keys: readonly string[],
): string | undefined {
	let current: unknown = input;
	for (const key of keys) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" ? current : undefined;
}

export function collectQwenAsrProvenanceBlockers(input: unknown): string[] {
	const blockers: string[] = [];
	const asrBase = readStringPath(input, ["lineage", "asr", "base"]);
	if (asrBase && QWEN_PROVENANCE_RE.test(asrBase)) {
		blockers.push(
			`lineage.asr.base: a strict/defaultEligible Gemma-4 release must not ship Qwen ASR provenance (${asrBase})`,
		);
	}
	const asrRepo = readStringPath(input, [
		"provenance",
		"sourceModels",
		"asr",
		"repo",
	]);
	if (asrRepo && QWEN_PROVENANCE_RE.test(asrRepo)) {
		blockers.push(
			`provenance.sourceModels.asr.repo: a strict/defaultEligible Gemma-4 release must not source ASR from Qwen (${asrRepo})`,
		);
	}
	return blockers;
}

export function readBundleAsrProvenanceBlockers(bundleRoot: string): string[] {
	const manifestPath = path.join(bundleRoot, "eliza-1.manifest.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return [];
	}
	if (!claimsStrictRelease(parsed, { allowVersionStaging: true })) return [];
	return collectQwenAsrProvenanceBlockers(parsed);
}

/** GGUF `general.architecture` of the fused library's Parakeet-TDT backend. */
export const PARAKEET_TDT_ARCHITECTURE = "parakeet-tdt";

const GGUF_SCALAR_BYTES: Readonly<Record<number, number>> = {
	0: 1,
	1: 1,
	2: 2,
	3: 2,
	4: 4,
	5: 4,
	6: 4,
	7: 1,
	10: 8,
	11: 8,
	12: 8,
};

/**
 * Read `general.architecture` from a GGUF header, or null when the file is
 * not a GGUF or the key is not among the leading scalar/string entries
 * (converters write it first). Reads at most the first 64 KiB.
 */
export function readGgufArchitecture(file: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const head = Buffer.alloc(64 * 1024);
		const length = readSync(fd, head, 0, head.length, 0);
		const buf = head.subarray(0, length);
		if (buf.length < 24 || buf.toString("ascii", 0, 4) !== "GGUF") return null;
		const kvCount = buf.readBigUInt64LE(16);
		let offset = 24;
		const readString = (): string | null => {
			if (offset + 8 > buf.length) return null;
			const size = Number(buf.readBigUInt64LE(offset));
			offset += 8;
			if (size > buf.length - offset) return null;
			const value = buf.toString("utf8", offset, offset + size);
			offset += size;
			return value;
		};
		for (let i = 0n; i < kvCount; i++) {
			const key = readString();
			if (key === null || offset + 4 > buf.length) return null;
			const type = buf.readUInt32LE(offset);
			offset += 4;
			if (type === 8) {
				const value = readString();
				if (value === null) return null;
				if (key === "general.architecture") return value;
			} else if (type in GGUF_SCALAR_BYTES) {
				offset += GGUF_SCALAR_BYTES[type] as number;
			} else {
				// An array before the architecture key: stop rather than walk it.
				return null;
			}
		}
		return null;
	} catch {
		// error-policy:J3 unreadable file is "not a parakeet GGUF".
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * True when `<bundle>/asr/` holds a model the fused library can load: a
 * Parakeet-TDT GGUF (Phonon-2, the mobile default), or a Qwen3-ASR text GGUF
 * together with its mmproj projector.
 */
export function bundleHasAsrModelFiles(bundleRoot: string): boolean {
	const asrDir = path.join(bundleRoot, "asr");
	if (!existsSync(asrDir)) return false;
	try {
		let hasTextModel = false;
		let hasProjector = false;
		for (const entry of readdirSync(asrDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) {
				continue;
			}
			if (
				readGgufArchitecture(path.join(asrDir, entry.name)) ===
				PARAKEET_TDT_ARCHITECTURE
			) {
				return true;
			}
			if (/mmproj|proj/i.test(entry.name)) {
				hasProjector = true;
			} else {
				hasTextModel = true;
			}
		}
		return hasTextModel && hasProjector;
	} catch {
		return false;
	}
}
