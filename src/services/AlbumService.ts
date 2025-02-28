import { constant, Constant, Inject, Service } from "@tsed/di";
import { AlbumRepo } from "../db/repo/AlbumRepo.js";
import { BucketRepo } from "../db/repo/BucketRepo.js";
import { BadRequest, NotFound } from "@tsed/exceptions";
import { AlbumModel } from "../model/db/Album.model.js";
import { Builder } from "builder-pattern";
import { FileRepo } from "../db/repo/FileRepo.js";
import { FileService } from "./FileService.js";
import { FileUtils } from "../utils/Utils.js";
import { FileUploadModel } from "../model/db/FileUpload.model.js";
import { ThumbnailCacheRepo } from "../db/repo/ThumbnailCacheRepo.js";
import fs, { ReadStream } from "node:fs";
import GlobalEnv from "../model/constants/GlobalEnv.js";
import { MimeService } from "./MimeService.js";
import { Logger } from "@tsed/logger";
import { AfterInit } from "@tsed/common";
import { uuid } from "../utils/uuidUtils.js";
import { ZipFilesService } from "./microServices/zipFiles/ZipFilesService.js";
import { ThumbnailService } from "./microServices/thumbnails/thumbnailService.js";
import BucketType from "../model/constants/BucketType.js";

@Service()
export class AlbumService implements AfterInit {
    public constructor(
        @Inject() private albumRepo: AlbumRepo,
        @Inject() private bucketRepo: BucketRepo,
        @Inject() private fileRepo: FileRepo,
        @Inject() private fileService: FileService,
        @Inject() private thumbnailCacheRepo: ThumbnailCacheRepo,
        @Inject() private mimeService: MimeService,
        @Inject() private logger: Logger,
        @Inject() private zipFilesService: ZipFilesService,
        @Inject() private thumbnailService: ThumbnailService,
    ) {}

    @Constant(GlobalEnv.ZIP_MAX_SIZE_MB, "512")
    private readonly zipMaxFileSize: string;

    @Constant(GlobalEnv.ALBUM_FILE_LIMIT, "256")
    private readonly fileLimit: string;

    @Constant(GlobalEnv.REDIS_URI)
    private readonly redisUri: string;

    public defaultThumbnail: Buffer;

    public async $afterInit(): Promise<void> {
        this.defaultThumbnail = await fs.promises.readFile(
            new URL("../assets/images/thumbnail-gen-top.png", import.meta.url),
        );
    }

    public async createAlbum(name: string, bucketToken: string): Promise<AlbumModel> {
        const bucket = await this.bucketRepo.getBucket(bucketToken);
        if (!bucket) {
            throw new BadRequest(`Bucket with token ${bucketToken} not found`);
        }
        const albumWithNameExists = await this.albumRepo.albumNameExists(name, bucketToken);
        if (albumWithNameExists) {
            throw new BadRequest(`Album with name ${name} already exists`);
        }

        const albumModel = Builder(AlbumModel).bucketToken(bucketToken).name(name).albumToken(uuid()).build();
        return this.albumRepo.saveOrUpdateAlbum(albumModel);
    }

    public async getAlbum(albumToken: string): Promise<AlbumModel> {
        const album = await this.albumRepo.getAlbum(albumToken);
        if (!album) {
            throw new NotFound("Album not found");
        }
        return album;
    }

    public async deleteAlbum(albumToken: string, removeFiles: boolean): Promise<boolean> {
        const album = await this.albumRepo.getAlbum(albumToken);
        if (!album) {
            throw new BadRequest(`Album with token ${albumToken} not found`);
        }
        this.checkPrivateToken(albumToken, album);
        const didDeleteAlbum = await this.albumRepo.deleteAlbum(albumToken, removeFiles);
        if (!didDeleteAlbum) {
            throw new BadRequest(`Unable to delete album with token: "${albumToken}"`);
        }
        if (removeFiles) {
            if (album.files) {
                await this.fileService.deleteFilesFromDisk(album.files);
            }
        } else {
            if (album.files) {
                const fileIds = album.files.map(f => f.id);
                await this.thumbnailCacheRepo.deleteThumbnailCaches(fileIds);
            }
        }
        return true;
    }

    public async disassociateFilesFromAlbum(albumToken: string, files: string[]): Promise<AlbumModel> {
        let album = await this.albumRepo.getAlbum(albumToken);
        if (!album) {
            throw new BadRequest(`Album with token ${albumToken} not found`);
        }
        this.checkPrivateToken(albumToken, album);
        const filesToRemove = await this.fileRepo.getEntries(files);

        if (album.files && !files.every(file => album!.files!.find(f => f.token === file))) {
            throw new BadRequest(`Every file must be in the same album`);
        }

        album = await this.removeFilesFromAlbum(albumToken, filesToRemove);
        await this.thumbnailCacheRepo.deleteThumbnailCaches(filesToRemove.map(f => f.id));
        return album;
    }

    public async assignFilesToAlbum(albumToken: string, files: string[]): Promise<AlbumModel> {
        const fileLimit = Number.parseInt(this.fileLimit, 10);
        const album = await this.albumRepo.getAlbum(albumToken, true);
        if (!album) {
            throw new BadRequest(`Album with token ${albumToken} not found`);
        }
        this.checkPrivateToken(albumToken, album);
        const filesToAssociate = await this.fileRepo.getEntries(files, false);
        if (filesToAssociate.length !== files.length) {
            throw new BadRequest(`some files were not found`);
        }

        const albumBucketToken = album.bucketToken;

        if (!filesToAssociate.every(entry => entry.bucketToken === albumBucketToken)) {
            throw new BadRequest(`All files must be in the same bucket`);
        }

        for (const file of filesToAssociate) {
            this.validateForAssociation(file);
        }

        const fileIdsInAlbum = album.files?.map(f => f.id) ?? [];
        const fileIdsToAdd = filesToAssociate.map(f => f.id).filter(f => !fileIdsInAlbum.includes(f));
        const bucket = await album.bucket;
        if (
            fileIdsInAlbum.length + fileIdsToAdd.length > fileLimit &&
            (bucket?.type ?? BucketType.NORMAL) == BucketType.NORMAL
        ) {
            throw new BadRequest(`Album cannot have more than ${fileLimit} files`);
        }

        const model = await this.addFilesToAlbum(albumToken, filesToAssociate);

        if (album.isShared) {
            await this.generateThumbnails(
                album.albumToken,
                filesToAssociate.map(f => f.id),
            );
        }

        return model;
    }

    private async addFilesToAlbum(albumToken: string, files: FileUploadModel[]): Promise<AlbumModel> {
        for (const file of files) {
            file.albumToken = albumToken;
        }
        await this.fileRepo.saveEntries(files);
        return (await this.albumRepo.getAlbum(albumToken))!;
    }

    private async removeFilesFromAlbum(albumToken: string, files: FileUploadModel[]): Promise<AlbumModel> {
        const removeTokens = files.map(f => f.token);
        const album = await this.albumRepo.getAlbum(albumToken);
        if (!album) {
            throw new BadRequest(`Album with token ${albumToken} not found`);
        }
        this.checkPrivateToken(albumToken, album);
        for (const file of album.files ?? []) {
            if (removeTokens.includes(file.token)) {
                file.albumToken = null;
            }
        }
        await this.albumRepo.saveOrUpdateAlbum(album);
        return (await this.albumRepo.getAlbum(albumToken))!;
    }

    public async revokeShare(albumToken: string): Promise<void> {
        const album = await this.albumRepo.getAlbum(albumToken, false);
        if (!album) {
            throw new BadRequest(`Album with token ${albumToken} not found`);
        }
        this.checkPrivateToken(albumToken, album);
        await this.albumRepo.setShareStatus(albumToken, false);
    }

    public async shareAlbum(albumToken: string): Promise<string> {
        const album = await this.albumRepo.getAlbum(albumToken, false);
        if (!album) {
            throw new BadRequest(`Album with token ${albumToken} not found`);
        }
        this.checkPrivateToken(albumToken, album);
        if (album.publicUrl) {
            return album.publicUrl;
        }
        album.publicToken = (await this.albumRepo.setShareStatus(albumToken, true))!;
        await this.generateThumbnails(album.albumToken);

        return album.publicUrl!;
    }

    public albumExists(publicToken: string): Promise<boolean> {
        return this.albumRepo.albumExists(publicToken);
    }

    public async generateThumbnails(privateAlbumToken: string, filesIds: number[] = []): Promise<void> {
        const album = await this.albumRepo.getAlbum(privateAlbumToken, true);
        if (!album) {
            throw new NotFound("Album not found");
        }
        this.checkPrivateToken(privateAlbumToken, album);

        const promise = this.thumbnailService.generateThumbnail(album, filesIds);

        promise
            .then(() => this.logger.info(`Successfully generated thumbnails for album ${privateAlbumToken}`))
            .catch(e => this.logger.error(e));
    }

    public async getThumbnail(imageId: number, publicAlbumToken: string): Promise<[Buffer, string, boolean]> {
        const albumToken = await this.albumRepo.getPrivateAlbumToken(publicAlbumToken);
        if (!albumToken) {
            throw new NotFound("Album not found");
        }
        const entry = await this.albumRepo.getEntry(albumToken, imageId);
        if (!entry) {
            throw new NotFound("File not found");
        }
        if (entry.fileProtectionLevel !== "None") {
            throw new BadRequest("File is protected");
        }

        const thumbnailFromCache = await this.thumbnailCacheRepo.getThumbnailBuffer(imageId);
        if (thumbnailFromCache && thumbnailFromCache.length > 0) {
            const thumbnailMime = await this.getThumbnailMime(entry, thumbnailFromCache);
            return [thumbnailFromCache, thumbnailMime, true];
        }

        // something went wrong, the entry is in the DB, but data is an empty string, re-generate thumbnail
        if (thumbnailFromCache && thumbnailFromCache.length === 0 && FileUtils.isValidForThumbnail(entry)) {
            this.generateThumbnails(albumToken, [imageId]);
        }

        if (FileUtils.isValidForThumbnail(entry)) {
            return [this.defaultThumbnail, "image/png", false];
        }

        throw new BadRequest("File not supported for thumbnail generation");
    }

    public async getThumbnailMime(entry: FileUploadModel | null, thumbNail: Buffer): Promise<string> {
        const detectedMime = await this.mimeService.findMimeTypeFromBuffer(thumbNail);
        if (detectedMime) {
            return detectedMime;
        }
        if (entry) {
            if (FileUtils.isImage(entry)) {
                return entry.mediaType!;
            } else if (FileUtils.isVideo(entry)) {
                return "image/jpeg";
            }
        }
        throw new BadRequest("File not supported for thumbnail generation");
    }

    public async downloadFiles(publicAlbumToken: string, fileIds: number[]): Promise<[ReadStream, string, string]> {
        const album = await this.albumRepo.getAlbum(publicAlbumToken);
        if (!album) {
            throw new NotFound("Album not found");
        }

        const files = album.files ?? [];

        const albumFileIds = files.map(f => f.id);
        if (fileIds.length > 0 && !fileIds.every(file => albumFileIds.includes(file))) {
            throw new BadRequest("Some files were not found in the album");
        }

        const filesToZip = files.filter(
            file => (fileIds.length === 0 || fileIds.includes(file.id)) && file.fileProtectionLevel === "None",
        );

        const sumFileSize = filesToZip.reduce((n, { fileSize }) => n + fileSize, 0);
        const parsedZipSize = Number.parseInt(this.zipMaxFileSize);
        if (parsedZipSize > 0 && sumFileSize > parsedZipSize * 1024 * 1024) {
            throw new BadRequest("Zip file is too large");
        }

        const zipLocation = await this.zipFilesService.zipFiles(filesToZip, album.name);

        return [fs.createReadStream(zipLocation), album.name, zipLocation];
    }

    public isAlbumTooBigToDownload(album: AlbumModel): boolean {
        const maxFileSizeMb = constant(GlobalEnv.ZIP_MAX_SIZE_MB, "512");
        const parsedValue = Number.parseInt(maxFileSizeMb);
        if (album.files && parsedValue > 0) {
            return album.files.reduce((acc, file) => acc + file.fileSize, 0) > parsedValue * 1024 * 1024;
        }
        return false;
    }

    private checkPrivateToken(token: string, album: AlbumModel): void {
        if (album.isPublicToken(token)) {
            throw new BadRequest("Supplied token is not valid");
        }
    }

    private checkPublicToken(token: string, album: AlbumModel): void {
        if (!album.isPublicToken(token)) {
            throw new BadRequest("Supplied token is not valid");
        }
    }

    private validateForAssociation(file: FileUploadModel): void {
        if (file.settings?.oneTimeDownload) {
            throw new BadRequest("One time downloads are not allowed");
        }
    }
}
