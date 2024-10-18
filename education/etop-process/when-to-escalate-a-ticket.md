---
description: >-
  Our team has been working to build better processes and this is one of the big
  ones we rely on daily to keep our team from spinning their wheels and to
  minimize wasting clients time.
---

# When to Escalate a Ticket

At eTop Technology, our goal is to resolve issues as quickly as possible, but sometimes problems require more expertise. Here's how to know when to escalate a ticket to ensure a smooth resolution:

**Things to Keep in Mind:**

* **Client’s Schedule:** Be aware of when a client is working. If troubleshooting remotely, ensure they’re not actively using their computer. If the issue isn’t urgent, reschedule to avoid disrupting their workday.
* **End of Day:** If it’s close to the client’s normal end of the day (e.g., 5PM), consider rescheduling if the issue isn’t critical. No one wants to stay late unless it’s necessary.
* **Path Forward:** Do you know the exact steps to fix the problem? If you’re still testing with no clear solution in sight, it’s probably time to escalate.
* **Training:** Are you confident in handling the issue? If not, another team member may be better suited.
* **Urgency:** Is this an issue that can wait or does it block a critical function? If it’s high urgency, escalate sooner rather than later.

***

#### **Escalation Time Limits**

To keep ticket flow smooth, we have set limits to help you decide when to escalate:

**First Touch (T1/2):**

* **Diagnosis Plan:** Should be made within 30 minutes. If not, escalate.
* **Fix Implementation:** Should be made within 60 minutes. If not, escalate.

**Tier 3/Service Desk Manager:**

* **Diagnosis Plan:** Same as above—30 minutes.
* **Fix Implementation:** 60 minutes, or escalate.
* **Manager Discretion:** The Service Desk Manager can override these time limits, but documentation is still required.

**Sr IT Manager:**

* **Diagnosis Plan:** Within 60 minutes. If unresolved, escalate.
* **Fix Implementation:** If a fix isn’t working after 60 minutes, escalate.
* **Manager Discretion:** The Sr IT Manager can override the limits but must document the decision.

**Final Escalation:**

If all previous efforts don’t resolve the issue, involve the Sr IT Manager, Service Desk Manager, and Account Manager to create a new plan. Communicate this to the client.

***

#### **Types of Escalations**

1. **Knowledge Gaps:**
   * You might face tickets outside your expertise. When this happens, still try to diagnose the issue. This helps identify gaps in knowledge and training.
   * Use internal documentation, error logs, or Google to diagnose.
   * If you can't fix it, note what you've tried and escalate.
2. **Permission Issues:**
   * Sometimes, you don’t have the necessary permissions. Escalate when you’ve identified the issue and need higher-level access to fix it.
   * Document exactly what permissions are missing and what steps need to be taken.

***

#### **How to Document an Escalation**

Every escalation should include a clear note following this template:

1. **Reason for Escalation:** (Time/Knowledge/Urgency)
2. **Steps Attempted:** Detail each troubleshooting step taken.
3. **Error Codes:** List any error codes or messages observed.
4. **Internal Discussions:** Include outcomes of any internal discussions before escalation.

***

#### **Example Escalation:**

**Issue:** Client’s Cloudflare ZTNA agent isn’t allowing local network access.

**Reason for Escalation:** Time & Knowledge.

**Steps Attempted:**

1. Toggled ZTNA agent connection.
2. Connected to an alternate WiFi network.
3. Reviewed Event Viewer and Cloudflare logs.

**Error Code:** "404 Unable to find managed network beacon."

**Research:** Found the error means the local beacon server isn’t found. I’m unfamiliar with this server’s setup.

**Next Steps:** Escalate for further support and request training on Cloudflare ZTNA beacon setup.
