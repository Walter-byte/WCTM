import { Injectable } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';

import { ApplicationConfigService } from '../config/application-config.service';

export type JwtPayload = Record<string, unknown>;

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configuration: ApplicationConfigService
  ) {}

  signAccessToken(payload: JwtPayload): Promise<string> {
    return this.jwtService.signAsync(payload, {
      expiresIn: this.configuration.jwt
        .accessTokenTtl as JwtSignOptions['expiresIn'],
      secret: this.configuration.jwt.secret,
    });
  }

  verifyAccessToken(token: string): Promise<JwtPayload> {
    return this.jwtService.verifyAsync<JwtPayload>(token, {
      secret: this.configuration.jwt.secret,
    });
  }
}
