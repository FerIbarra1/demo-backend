import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { SmtpAdapter } from './adapters/smtp.adapter';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [MailService, SmtpAdapter],
  exports: [MailService],
})
export class MailModule {}
