import { FileUploadModel } from "../model/db/FileUpload.model.js";

/**
 * An admin service is a service that the admin page will use to be able to render content.
 * there can be multiple sources of data for the admin pages, but this is a minimum requirement for them to function
 */
export interface IAdminService {
    getAllEntries(): Promise<FileUploadModel[]>;
    deleteEntries(ids: number[]): Promise<boolean>;
    getPagedEntries(
        start: number,
        length: number,
        sortColumn?: string,
        sortDir?: string,
        search?: string,
    ): Promise<FileUploadModel[]>;
    getFileSearchRecordCount(search: string): Promise<number>;
    getFileRecordCount(): Promise<number>;
    getStatsData(): Promise<FileUploadModel[]>;
}
