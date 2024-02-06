import {Inject, Service} from "@tsed/di";
import {AsyncTask, Job, SimpleIntervalJob, type SimpleIntervalSchedule, ToadScheduler} from "toad-scheduler";
import schedule, {Job as DateJob, type JobCallback} from "node-schedule";
import {Logger} from "@tsed/logger";
import {ObjectUtils} from "../utils/Utils.js";

@Service()
export class ScheduleService {
    public constructor(
        @Inject() private logger: Logger
    ) {
    }

    private static readonly scheduler = new ToadScheduler();

    private static readonly dateSchedules: DateJob[] = [];

    public scheduleJobInterval<T>(schedule: SimpleIntervalSchedule, jobHandler: (this: T) => Promise<void>, jobName: string, context: T): void {
        jobHandler = jobHandler.bind(context);
        const task = new AsyncTask(
            jobName,
            jobHandler
        );
        const job = new SimpleIntervalJob(schedule, task, {
            id: jobName
        });
        ScheduleService.scheduler.addSimpleIntervalJob(job);
        this.logger.info(`Registered interval job ${jobName}`);
    }

    public scheduleJobAtDate<T>(name: string, when: Date, jobHandler: JobCallback, context: T): void {
        if (when.getTime() < Date.now()) {
            this.logger.warn(`Unable to schedule job "${name}" as the date (${when.toUTCString()}) is before now`);
            return;
        }
        jobHandler = jobHandler.bind(context);
        const job = schedule.scheduleJob(name, when, (fireDate: Date) => {
            jobHandler.call(context, fireDate);
            ObjectUtils.removeObjectFromArray(ScheduleService.dateSchedules, itm => itm === job);
        });
        ScheduleService.dateSchedules.push(job);
        this.logger.info(`Registered date job ${name} to run on ${when.toUTCString()}`);
    }

    public getAllIntervalJobs(): Job[] {
        return ScheduleService.scheduler.getAllJobs();
    }

    public getAllDateJobs(): DateJob[] {
        return ScheduleService.dateSchedules;
    }
}
