import { describe, expect, it } from '@jest/globals';
import Joi from 'joi';

import { JoiValidationPipe } from './joi-validation.pipe';

describe('JoiValidationPipe', () => {
  const pipe = new JoiValidationPipe(
    Joi.object({ name: Joi.string().trim().min(1).required() })
  );

  it('returns converted input and strips unknown fields', () => {
    expect(
      pipe.transform({ name: ' Tenant ', tenantId: 'client-value' })
    ).toEqual({ name: 'Tenant' });
  });

  it('reports all validation failures as a bad request', () => {
    expect(() => pipe.transform({ name: '' })).toThrow('Bad Request');
  });
});
