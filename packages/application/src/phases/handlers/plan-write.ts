import { PhaseName } from '@ai-sdlc/domain';
import { SingleShotAgentHandler } from './single-shot-agent-handler.js';

export class PlanWriteHandler extends SingleShotAgentHandler {
  constructor() {
    super(PhaseName('plan-write'), 'plan-write');
  }
}
