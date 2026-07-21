import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import Joi from 'joi';

@Injectable()
export class JoiValidationPipe implements PipeTransform {
  constructor(private readonly schema: Joi.Schema) {}

  transform(value: unknown): unknown {
    const result = this.schema.validate(value, {
      abortEarly: false,
      convert: true,
      stripUnknown: true,
    });

    if (result.error) {
      throw new BadRequestException({
        error: 'Bad Request',
        message: result.error.details.map((detail) => detail.message),
      });
    }

    return result.value;
  }
}
