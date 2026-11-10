export function renderTaskPrompt({ role, goal, files = [], constraints = [], steps = [], successCriteria = null, verifyCommand = null }) {
  const limitedSteps = steps.slice(0, 5);
  const sections = [
    ["ROLE", role],
    ["GOAL", goal],
    ["FILES", files.length ? files.map((file) => `- ${file}`).join("\n") : "- Repository files (read-only)"],
    ["CONSTRAINTS", constraints.map((line) => `- ${line}`).join("\n")],
    ["STEPS", limitedSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")],
    ["DONE WHEN", [successCriteria ? `success criteria: ${successCriteria}` : "success criteria: provide a concise research answer", verifyCommand ? `verify command: ${verifyCommand}` : "verify command: n/a"].join("\n")],
    ["OUTPUT", "End with exactly this block and nothing after it:\n\n## Result\nstatus: done | blocked\nchanged_files: <comma list, or none>\nnotes: <one line>"],
  ];
  return sections.map(([title, body]) => `## ${title}\n\n${String(body ?? "").trim()}`).join("\n\n") + "\n";
}

export function renderExecutePrompt({ task, files, successCriteria, verifyCommand, allowBash = false }) {
  return renderTaskPrompt({
    role: "You are a small local coding agent operating inside a disposable sandbox.",
    goal: task,
    files,
    constraints: [
      "Edit only the declared files. Do not create, delete, or modify any other path.",
      "Use the available read, edit, write, grep, find, and ls tools; use bash only when explicitly allowed.",
      ...(allowBash ? ["bash is explicitly allowed for this task."] : ["bash is not available for this task."]),
      "Keep the change narrow and do not claim checks passed unless you actually ran them.",
    ],
    steps: ["Inspect the declared files.", "Make the smallest change that meets the goal.", "Run the requested verification command if available.", "Summarize the actual result."],
    successCriteria,
    verifyCommand,
  });
}

export function renderResearchPrompt({ question }) {
  return renderTaskPrompt({
    role: "You are a small local research agent. You are strictly read-only.",
    goal: question,
    constraints: ["Do not edit files or run write commands.", "Use only read, grep, find, and ls.", "Cite relevant file paths and line numbers when possible."],
    steps: ["Inspect the relevant repository files.", "Trace the evidence needed to answer the question.", "Return a concise evidence-based answer."],
  });
}
