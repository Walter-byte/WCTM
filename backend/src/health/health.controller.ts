import { Controller, Get } from '@nestjs/common';

import { Public } from '../auth/decorators/public.decorator';
import { type ReadinessResult, ReadinessService } from './readiness.service';

@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  getHealth(): { status: string } {
    return { status: 'ok' };
  }

  @Get('readiness')
  getReadiness(): Promise<ReadinessResult> {
    return this.readiness.check();
  }
}
