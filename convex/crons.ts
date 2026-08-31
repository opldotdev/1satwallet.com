import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
	"delete expired CWI auth records",
	{ hours: 1 },
	internal.cwiAuth.deleteExpiredRecords,
);

crons.interval(
	"expire P2P records and purge terminals after 24 hours",
	{ minutes: 5 },
	internal.p2p.deleteExpiredRecords,
);

export default crons;
