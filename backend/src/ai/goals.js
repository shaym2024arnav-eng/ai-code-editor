// Improvement goals the user can pick. Each one tells the model what to optimize for.
const GOALS = {
  readability: {
    label: "Readability",
    focus: "Make the code easier to read and understand: clear names, smaller functions, less nesting, remove duplication, helpful comments only where intent is not obvious.",
  },
  performance: {
    label: "Performance",
    focus: "Improve runtime and memory efficiency: avoid repeated work, unnecessary re-renders, N+1 queries, blocking calls and needless copies. Only change what has a real performance benefit, and explain the benefit.",
  },
  security: {
    label: "Security",
    focus: "Find and fix security problems: input validation, injection, path traversal, authorization checks, secrets in code, unsafe defaults, missing limits. Explain each risk concretely.",
  },
  maintainability: {
    label: "Maintainability",
    focus: "Improve structure for future changes: separation of concerns, cohesion, consistent error handling, removing dead code, and following the project's existing patterns.",
  },
  bugs: {
    label: "Find & fix bugs",
    focus: "Find real bugs: wrong logic, unhandled errors and promise rejections, race conditions, off-by-one errors, null/undefined access, edge cases. Fix them with minimal changes.",
  },
  types: {
    label: "Types & docs",
    focus: "Add or improve types (TypeScript types for .ts/.tsx files, JSDoc for .js files) and short doc comments for exported functions, without changing behavior.",
  },
  custom: {
    label: "Custom goal",
    focus: "Follow the user's instructions exactly.",
  },
};

const isGoal = (g) => Object.prototype.hasOwnProperty.call(GOALS, g);

module.exports = { GOALS, isGoal };
