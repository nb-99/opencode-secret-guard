const parserOpts = {
  // Angular's default headerPattern ignores the Conventional Commits `!`
  // breaking-change marker (such as `feat!:` or `fix(paths)!:`), which this
  // repository uses. Support both `!` headers and BREAKING CHANGE footers.
  breakingHeaderPattern: /^(\w*)(?:\((.*)\))?!: (.*)$/,
  noteKeywords: ["BREAKING CHANGE", "BREAKING-CHANGE"],
};

export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", { parserOpts }],
    ["@semantic-release/release-notes-generator", { parserOpts }],
    [
      "@semantic-release/github",
      {
        // Keep the workflow token limited to contents: write; do not comment on
        // issues/PRs or open failure issues.
        successCommentCondition: false,
        failCommentCondition: false,
      },
    ],
  ],
};
