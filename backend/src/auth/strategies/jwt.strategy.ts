import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { ApplicationConfigService } from '../../config/application-config.service';
import type { JwtPayload } from '../auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configuration: ApplicationConfigService) {
    super({
      ignoreExpiration: false,
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configuration.jwt.secret,
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    return payload;
  }
}
