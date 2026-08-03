import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
// import { PrismaService } from './modules/prisma/prisma.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // app.get(PrismaService);

  app.setGlobalPrefix('api');

  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 5000);

  console.log(
    `🚀 Server running on http://localhost:${process.env.PORT || 5000}`,
  );
}
bootstrap();
