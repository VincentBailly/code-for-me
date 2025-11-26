The code in this project implement a coding agent.
The instructions should be simple and clear enough to be reliably understood by small models.
The instructions should not be authoritatian. If should just present the situation as clear as possible
so that the model can come up with its own (but correct) way to contribute the best to the agent.

The agent is based on the following principles:
- The smaller the context of each request, the smart the model, as long as all relevant information is in the context.
- models should be free to come up with their own strategies, as long as they fit the agent framework.
- Iterative work is what produces highest quality work, because it allows to focus on one aspect at the time.
- Rigid methodologies are bad. For example, doing some research and then implementing can be sometimes better and sometimes worse than smaller loops of reading, measuring, trying, etc...