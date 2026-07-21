import { describe, expect, it, jest } from '@jest/globals';

import type { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

describe('UsersService', () => {
  it('reads and updates only the authenticated persisted user profile', async () => {
    const profiles = new Map<
      string,
      {
        id: string;
        email: string;
        displayName: string | null;
        createdAt: Date;
        updatedAt: Date;
      }
    >([
      [
        'usr_a',
        {
          id: 'usr_a',
          email: 'a@example.com',
          displayName: 'Original',
          createdAt: new Date('2026-07-21T00:00:00.000Z'),
          updatedAt: new Date('2026-07-21T00:00:00.000Z'),
        },
      ],
      [
        'usr_b',
        {
          id: 'usr_b',
          email: 'b@example.com',
          displayName: 'Other User',
          createdAt: new Date('2026-07-21T00:00:00.000Z'),
          updatedAt: new Date('2026-07-21T00:00:00.000Z'),
        },
      ],
    ]);
    const findUnique = jest.fn(
      async ({ where }: { where: { id: string } }) =>
        profiles.get(where.id) ?? null
    );
    const updateMany = jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { displayName?: string | null };
      }) => {
        const profile = profiles.get(where.id);

        if (!profile) {
          return { count: 0 };
        }

        profile.displayName = data.displayName ?? null;
        return { count: 1 };
      }
    );
    const prisma = {
      user: { findUnique, updateMany },
    } as unknown as PrismaService;
    const service = new UsersService(prisma);

    await expect(
      service.getOwnProfile({ sub: 'usr_a' })
    ).resolves.toMatchObject({ id: 'usr_a', displayName: 'Original' });
    await expect(
      service.updateOwnProfile(
        { sub: 'usr_a', attemptedUserId: 'usr_b' },
        { displayName: 'Updated' }
      )
    ).resolves.toMatchObject({
      id: 'usr_a',
      email: 'a@example.com',
      displayName: 'Updated',
    });
    expect(profiles.get('usr_b')?.displayName).toBe('Other User');
  });

  it('fails closed when the authenticated subject is missing', async () => {
    const service = new UsersService({} as PrismaService);

    await expect(service.getOwnProfile(undefined)).rejects.toThrow(
      'Authenticated user subject is required'
    );
  });
});
