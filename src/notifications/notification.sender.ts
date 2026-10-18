import { z } from "zod";
import type { NotificationType } from "../generated/prisma/enums.js";

export const notificationMessageSchema = z.strictObject({
  to: z.email(), subject: z.string().min(1), text: z.string().min(1),
});

export type NotificationMessage = z.infer<typeof notificationMessageSchema> & {
  jobId: string;
  type: NotificationType;
};
export type NotificationSender = (message: NotificationMessage) => void | Promise<void>;

// Replace this adapter when adding an email provider. No email is sent in this version.
export const logNotification: NotificationSender = (message) => {
  console.log("[notification:console]", { delivery: "simulated", ...message });
};
