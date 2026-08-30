import { type INestApplication, RequestMethod } from '@nestjs/common';

export function configureApplicationRouting(
  application: INestApplication
): void {
  application.setGlobalPrefix('api', {
    exclude: [
      { path: 'onboarding', method: RequestMethod.GET },
      { path: 'onboarding/styles.css', method: RequestMethod.GET },
      { path: 'onboarding/app.js', method: RequestMethod.GET },
    ],
  });
}
