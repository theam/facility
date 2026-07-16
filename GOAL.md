Right now, we see a major limitation with the current approach to this project: it consists of a collection of scripts, skills, and other components that are managed through code across multiple services, GitHub repositories, and different systems. Teams run their AI SDLCs in isolated repositories, with custom configuration spread across files and code, and with poor or sparse visibility into the data the system produces.

Ideally, everything should be centralized into a single platform that governs all of this — a place where we can do the same things much more easily and with better control, in a more semantic way, enabling collaboration, reusability, and governance. Think of something similar to Vercel as a platform, but focused entirely on the AI SDLC process.

> **How we approach this from now on:** the product strategy and design laws live in [.claude/skills/control-plane-strategy/SKILL.md](.claude/skills/control-plane-strategy/SKILL.md); the current working spec is [docs/platform/REDESIGN.md](docs/platform/REDESIGN.md).

Following the TAM-50 brand system, design and build a platform that aligns with the vision presented at **https://sdlc.theagilemonkeys.com/** (theam/theam-ai-sdlc on GitHub) and Facility. This platform must be deployable by any organization on any cloud provider and enable companies to govern their entire AI SDLC process.

Some of the capabilities we want to support include:

* everything stated in sdlc.theagilemonkeys.com
* Manage different projects
* Comprehensive analytics, with clear separation and visibility across different projects.
* Execution sandboxes for Claude agents, Codex agents, and bring-your-own model providers.
* Live preview environments for every implementation pull request so humans can validate behavior quickly. Require provider-managed per-PR previews now; build native, provider-agnostic preview orchestration as an explicit roadmap capability.
* Enterprise-wide skill and project knowledge management: rules, harnesses, skills.
* Creation of new agents for the loop/system for project-specific use cases, with bundled versions of our recommended ones.
* Versioning and templating of the overall system.
* Project kickstarting that automatically generates all required repository assets, including identifiers, skills, configuration, and related files.
* Governance of all AI SDLC resources.
* Authentication, with WorkOS SSO as the initial authentication provider (following the same approach as theam/tam-os).
* Project upgrades to the latest Facility configuration, including repository fingerprints to detect corruption and guarantee repository integrity.
* Visibility into issues occurring throughout the AI SDLC lifecycle.
* Cost management through project-level API keys, controlled budgeting, and cost attribution by model, agent, and task.
* LLM proxying for auditing, observability, and centralized model access.
* Integration with multiple data sources capable of triggering issue creation and implementation workflows.
* Sandbox configuration management, including dependencies, Docker images, runtime configuration, templates, and execution environments.
* Being able to access Claude Code and Codex sessions of the agents directly through the platform to steer and diagnose stuck sessions if needed.
* it should work for github as a github app you install in your environment. 
* Inbox for the engineers to review human-in-the-loop requests from the agents.
* The platform should be ready for the AI world: users should be able to manage the platform safely through MCPs and CLIs so they can use Cowork, Claude Code, Codex, etc. to manage it.
* Users should have different levels of authorization. Bundled roles with different permissions and the possibility to create the roles  should be allowed. 
* The platform should be completely auditable and data mined. We should store everything by default so we can take advantage of all the data generated.
* Learning mode (similar to Claude dreaming mode): per project, an agent nightly learns what happened and builds out new skills, rules, knowledge base, that need to be validate by a human in the human in the loop.

* Knowledge base and project task management.For the knowledge base and task management, I envision an agent with a harness similar to our Limina project (https://github.com/theam/limina), but instead of managing research hypotheses, it acts as a Project Owner agent that owns the project domain, maintains the knowledge base, and generates implementation tasks. Javi (our CTO) has already been using this workflow internally for theam/tam-os, and the knowledge base has been maintained here:

https://github.com/theam/the-agile-monkeys-automation-expert

All of our agents—including Project Owner agents—must execute securely in isolated cloud sandboxes.

The platform must follow the visual identity of the theam/theam-ai-sdlc brand.

Additional requirements:

* Fully responsive on mobile devices.
* Extremely optimized, production-ready, and enterprise-grade.
* Designed with security and privacy as first-class concerns.
* Use industry-standard technologies for databases, infrastructure, interfaces, and connectivity.
* Architecture and implementation quality should reflect the standards expected from top-tier engineering teams.
* The platform must prioritize functionality and practical usefulness over unnecessary complexity.
* Everything must be thoroughly documented.
* Documentation should be ready for deployment using Docusaurus (or a similar documentation platform), following the same brand identity established for sdlc.theagilemonkeys.com (theam/theam-ai-sdlc).

When designing the platform, take inspiration from both:

* https://sdlc.theagilemonkeys.com/ (theam/theam-ai-sdlc)
* theam/tam-os

The first project/customer that must run on this platform is **tam-os**.

You must ensure that theam/tam-os project operates 100% on the new platform. The configuration from theam/tam-os was the origin of this entire initiative and is already running successfully in production. The migration and implementation must fully support the existing tam-os development process while making it native to the new platform.

We need very good taste for the UI/UX of this. This is the software factory of the future for engineers, but that doesn't mean it needs to be complex for the sake of being complex. Think about how the best UI are built and focus on delivering an experience that's very satisfying to use and that makes you feel in control. For each of the use cases and flows, think about what would be the best way to consume and interact with the system. Be disruptive and always think about the user needs.

Also, even if the system is fully configurable, you need to make sure that the defaults are good enough to help users kickstart with the platform with both greenfield projects and already created repositories. Making it as easy as possible for users to work is very important.

If you need to deploy infrastructure as your playground to try stuff, you have access to AWS in the .env file and may deploy whatever is necessary to validate the implementation.

Yo also have access to OpenAI and Anthropic through api keys in .env.

You are the full owner of this project, so I expect you to handle this end-to-end entirely. I expect you to direct this as the best engineering team would do, following the state-of-the-art AI, research, and engineering practices, using industry-grade and state-of-the-art libraries, tools, services, etc.
