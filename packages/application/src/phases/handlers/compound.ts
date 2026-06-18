import { PhaseName } from '@ai-sdlc/domain';
import { SingleShotAgentHandler } from './single-shot-agent-handler.js';

export class CompoundHandler extends SingleShotAgentHandler {
  constructor() {
    super(PhaseName('compound'), 'compound');
  }
}
