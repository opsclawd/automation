import { PhaseName } from '@ai-sdlc/domain';
import { SingleShotAgentHandler } from './single-shot-agent-handler.js';

export class PlanDesignHandler extends SingleShotAgentHandler {
  constructor() {
    super(PhaseName('plan-design'), 'plan-design');
  }
}
