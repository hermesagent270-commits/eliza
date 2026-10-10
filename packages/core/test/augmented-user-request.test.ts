/**
 * Document augmentation wraps the user's prompt after the retrieved documents.
 * Document text is inserted verbatim, so it can contain the request tags; the
 * user's request is the block after the documents, not the first tag.
 */

import { describe, expect, it } from "vitest";
import {
	extractUserText,
	userRequestFromAugmentedText,
} from "../src/utils/message-text";

function envelope(documentText: string, userPrompt: string): string {
	return [
		"Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
		"",
		"<contextual_documents>",
		`<source title="prompts.md" similarity="0.812">\n${documentText}\n</source>`,
		"</contextual_documents>",
		"",
		"<user_request>",
		userPrompt,
		"</user_request>",
	].join("\n");
}

describe("augmented user request", () => {
	it("returns the user's prompt when a document contains request tags", () => {
		const text = envelope(
			"Prompt template notes:\n<user_request>\n{{prompt}}\n</user_request>",
			"remind me to call mom at 6pm",
		);
		expect(extractUserText(text)).toBe("remind me to call mom at 6pm");
		expect(userRequestFromAugmentedText(text)).toBe(
			"remind me to call mom at 6pm",
		);
	});

	it("reads a plain envelope and leaves other text unchanged", () => {
		const text = envelope("x", "what is x?");
		expect(extractUserText(text)).toBe("what is x?");
		expect(
			extractUserText(`${text}\n[language instruction: reply in French]`),
		).toBe("what is x?");
		expect(userRequestFromAugmentedText(text)).toBe("what is x?");
		expect(userRequestFromAugmentedText("hello")).toBe("hello");
	});
});
