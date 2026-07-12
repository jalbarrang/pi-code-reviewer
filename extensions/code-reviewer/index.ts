import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerReviewCommand } from './commands/review';
import { registerReviewInitCommand } from './commands/review-init';
import { registerReviewLearnCommand } from './commands/review-learn';
import { registerReviewLensesCommand } from './commands/review-lenses';
import { registerReviewStatusCommand } from './commands/review-status';
import { registerReviewTool } from './commands/review-tool';

export default function codeReviewerExtension(pi: ExtensionAPI) {
  registerReviewCommand(pi);
  registerReviewInitCommand(pi);
  registerReviewLearnCommand(pi);
  registerReviewStatusCommand(pi);
  registerReviewLensesCommand(pi);
  registerReviewTool(pi);
}
