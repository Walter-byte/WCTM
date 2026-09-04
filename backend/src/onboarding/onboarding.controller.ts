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
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'publickey-credentials-get=()',
  'usb=()',
].join(', ');

@Controller('onboarding')
@Public()
export class OnboardingController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('X-Frame-Options', 'DENY')
  @Header('Permissions-Policy', PERMISSIONS_POLICY)
  page(): string {
    return ONBOARDING_HTML;
  }

  @Get('app.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('X-Frame-Options', 'DENY')
  @Header('Permissions-Policy', PERMISSIONS_POLICY)
  javascript(): string {
    return ONBOARDING_JAVASCRIPT;
  }

  @Get('styles.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  @Header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('X-Frame-Options', 'DENY')
  @Header('Permissions-Policy', PERMISSIONS_POLICY)
  styles(): string {
    return ONBOARDING_STYLES;
  }
}
