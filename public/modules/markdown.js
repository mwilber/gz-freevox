class MarkdownRenderer {
	static hasMarkdown(text) {
		return /```|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|^#{1,6}\s+|^\s*[-*]\s+|\[[^\]]+\]\([^)]+\)/m.test(
			text
		);
	}

	static render(text) {
		if (!text) {
			return "";
		}

		const codeBlocks = [];
		const textWithPlaceholders = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
			const index = codeBlocks.length;
			codeBlocks.push({ lang, code });
			return `@@CODEBLOCK_${index}@@`;
		});

		const escaped = MarkdownRenderer.escapeHtml(textWithPlaceholders);
		const lines = escaped.split("\n");
		let html = "";
		let inList = false;

		for (const line of lines) {
			const codePlaceholder = line.match(/^@@CODEBLOCK_(\d+)@@$/);
			if (codePlaceholder) {
				if (inList) {
					html += "</ul>";
					inList = false;
				}
				const block = codeBlocks[Number(codePlaceholder[1])];
				html += MarkdownRenderer.renderCodeBlock(block);
				continue;
			}

			const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
			if (headingMatch) {
				if (inList) {
					html += "</ul>";
					inList = false;
				}
				const level = headingMatch[1].length;
				html += `<h${level}>${MarkdownRenderer.applyInlineMarkdown(headingMatch[2])}</h${level}>`;
				continue;
			}

			const listMatch = line.match(/^\s*[-*]\s+(.*)$/);
			if (listMatch) {
				if (!inList) {
					html += "<ul>";
					inList = true;
				}
				html += `<li>${MarkdownRenderer.applyInlineMarkdown(listMatch[1])}</li>`;
				continue;
			}

			if (line.trim() === "") {
				if (inList) {
					html += "</ul>";
					inList = false;
				}
				continue;
			}

			if (inList) {
				html += "</ul>";
				inList = false;
			}

			html += `<p>${MarkdownRenderer.applyInlineMarkdown(line)}</p>`;
		}

		if (inList) {
			html += "</ul>";
		}

		return html;
	}

	static applyInlineMarkdown(text) {
		let output = text;
		output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
		output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
		output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");
		output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
		return output;
	}

	static renderCodeBlock(block) {
		if (!block) {
			return "";
		}
		const language = block.lang ? ` class="language-${MarkdownRenderer.escapeHtml(block.lang)}"` : "";
		return `<pre><code${language}>${MarkdownRenderer.escapeHtml(block.code)}</code></pre>`;
	}

	static escapeHtml(text) {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}
}

export { MarkdownRenderer };
