import "reflect-metadata";
import { $log, PlatformBuilder } from "@tsed/common";
import { PlatformExpress } from "@tsed/platform-express";
import { Server } from "./Server.js";
import { DataSource, type Logger as TypeOrmLogger } from "typeorm";
import { SQLITE_DATA_SOURCE } from "./model/di/tokens.js";
import { dataSource } from "./db/DataSource.js";
import { injectable, logger } from "@tsed/di";
import process from "process";
import { Application } from "express";

async function bootstrap(): Promise<void> {
    injectable(SQLITE_DATA_SOURCE)
        .asyncFactory(async () => {
            await dataSource.initialize();
            const loggerInstance = logger();
            dataSource.setOptions({
                logger: new (class LoggerProxy implements TypeOrmLogger {
                    public logQuery(query: string, parameters?: unknown[]): void {
                        loggerInstance.debug(query, parameters);
                    }

                    public logMigration(message: string): void {
                        loggerInstance.debug(message);
                    }

                    public log(level: "log" | "info" | "warn", message: unknown): void {
                        switch (level) {
                            case "log":
                            case "info":
                                loggerInstance.info(message);
                                break;
                            case "warn":
                                loggerInstance.warn(message);
                                break;
                        }
                    }

                    public logSchemaBuild(message: string): void {
                        loggerInstance.debug(message);
                    }

                    public logQueryError(error: string | Error, query: string, parameters?: unknown[]): void {
                        loggerInstance.error(error, query, parameters);
                    }

                    public logQuerySlow(time: number, query: string, parameters?: unknown[]): void {
                        loggerInstance.warn(time, query, parameters);
                    }
                })(),
            });
            loggerInstance.info(`Connected with typeorm to database: ${dataSource.options.database}`);
            return dataSource;
        })
        .hooks({
            $onDestroy(dataSource: DataSource) {
                return dataSource.isInitialized && dataSource.destroy();
            },
        });

    let platform: PlatformBuilder<Application> | null = null;
    try {
        platform = await PlatformExpress.bootstrap(Server);
        await platform.listen();

        process.on("SIGINT", () => {
            if (platform) {
                platform.stop();
            }
        });
        await stopOnTest(platform, false);
    } catch (error) {
        $log.error({ event: "SERVER_BOOTSTRAP_ERROR", message: error.message, stack: error.stack });
        await stopOnTest(platform, true);
    }
}

async function stopOnTest(platform: PlatformBuilder<Application> | null, error: boolean): Promise<void> {
    const argv = process.argv.slice(2);
    if (!argv.includes("-closeOnStart")) {
        return;
    }
    if (platform) {
        await platform.stop();
    }
    if (error) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

bootstrap();
