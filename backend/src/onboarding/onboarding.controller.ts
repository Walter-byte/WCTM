import { Controller, Get, Header } from '@nestjs/common';

import { Public } from '../auth/decorators/public.decorator';
import {
  ONBOARDING_HTML,
  ONBOARDING_JAVASCRIPT,
  ONBOARDING_STYLES,
} from './onboarding.assets';

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

@Controller('onboarding')
@Public()
export class OnboardingController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  page(): string {
    return ONBOARDING_HTML;
  }

  @Get('app.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  javascript(): string {
    return ONBOARDING_JAVASCRIPT;
  }

  @Get('styles.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  styles(): string {
    return ONBOARDING_STYLES;
  }
}
